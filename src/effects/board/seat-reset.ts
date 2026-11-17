import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import {
  RESET_SEATS, seatNoResetMessage, SEAT_RESET_COMMAND, SEAT_RESET_RETRIES, handoffIdentity, seatResetClaimPath,
  seatResetLogPath, seatResetRequestPath, seatResetDirectory, seatResumePrompt, seatRewriteMessage,
  type SeatLaunchModel, type SeatResetAction, type SeatResetIdentity,
} from '../../core/board/seat-reset';
import { HerdrCoreError, RH_LABEL, hcGet, hcKeys, hcList, hcSend, hcWait, type HcLabels, type HcWaitResult, type HerdrCoreOptions } from '../terminal/herdr-core';
import { readNotifyConfig } from '../terminal/notify-read';
import {
  fileSize, handoffProblem, newSession, readAppended, readRequest, readSeatSession, requestOpen, sentResumed,
  type NewSession, type SeatRequest,
} from './seat-reset-store';

export {
  readTranscriptUsage, writeSeatResetRequest, seatResetRequested, recordSeatSession, readSeatSession,
  type TranscriptUsage, type SeatResetRequestRecord, type SeatSessionRecord,
} from './seat-reset-store';

/** `nothing_sent`: no terminal got a message. `uncertain`: the requester may already be cleared, or got part of a message. */
export type SeatResetOutcome = 'nothing_sent' | 'rewrite_requested' | 'no_reset' | 'uncertain';

export type SeatResetCode = 'handoff_path_invalid' | 'handoff_missing' | 'request_missing' | 'handoff_stale' | 'handoff_sha256_mismatch'
  | 'handoff_sections_missing' | 'already_claimed' | 'claim_failed' | 'caller_unknown' | 'requester_not_found' | 'requester_busy' | 'message_not_sent'
  | 'hc_failed' | 'resume_not_sent' | 'request_invalid' | 'request_closed';

export class SeatResetError extends Error {
  constructor(readonly code: SeatResetCode, readonly outcome: SeatResetOutcome, message: string, readonly logErrors: readonly string[] = []) {
    super(message);
  }
}

/** The characters that `hc keys` takes as single-character key names, and the space key. */
const TYPABLE = /^[A-Za-z0-9 /.-]+$/u;

/**
 * Types one line and Enter with `hc keys`. `hc send` wraps its text in an envelope, so Claude reads a sent slash
 * command as chat text and a shell reads a sent line as a parse error.
 */
function typeLine(terminal: string, line: string, options: HerdrCoreOptions): void {
  if (!TYPABLE.test(line)) throw new Error(`${JSON.stringify(line)} has a character that hc keys cannot type`);
  hcKeys(terminal, [...[...line].map(character => (character === ' ' ? 'space' : character)), 'enter'], options);
}

/** An error message without its final period, for use inside a sentence. */
const sentence = (error: unknown): string => (error as Error).message.replace(/\.$/u, '');

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export interface SeatResetTimeouts {
  readonly signalMs: number;
  /** The signal budget after `/compact`: a compaction in this repository took 71 s median and 237 s max. */
  readonly compactSignalMs: number;
  readonly evidenceMs: number;
  readonly exitMs: number;
  readonly pollMs: number;
}

const TIMEOUTS: SeatResetTimeouts = { signalMs: 60_000, compactSignalMs: 300_000, evidenceMs: 120_000, exitMs: 60_000, pollMs: 1_000 };
const WAIT_SECONDS = 600;

/** The notice port of the reset: one bot event to the configured notify channels; a failure is a result. */
export type SeatResetNotify = (env: NodeJS.ProcessEnv, event: {
  readonly repository: string | null; readonly kind: string; readonly data: Record<string, unknown>; readonly text: string;
}) => Promise<'sent' | 'failed' | 'not_configured'>;

/**
 * The launch of `rh seats argv <seat> --repository-id <id>` under the current quota: its argv and its effective
 * model and effort. `modeKnown` is false when the seat account has no fresh weekly reading, so the mode is unknown.
 */
export interface SeatRelaunch extends SeatLaunchModel {
  readonly argv: readonly string[];
  readonly modeKnown: boolean;
}

export interface SeatResetOptions extends HerdrCoreOptions {
  /** The seat launch for the relaunch and for the model check of a tier-2 reset. */
  readonly relaunch: (identity: SeatResetIdentity) => Promise<SeatRelaunch>;
  /** Tests only: shorter waits. */
  readonly timeouts?: SeatResetTimeouts;
  /** Posts one notice. Only the peer-runtime plugin supplies it; without it every failure records `not_configured`. */
  readonly notify?: SeatResetNotify;
}

export interface SeatResetResult {
  readonly requester: string;
  readonly seat: string;
  readonly relaunched: boolean;
  /** Reset log lines that could not be written; the reset went on without them. */
  readonly logErrors: readonly string[];
}

/** The notices of one run get this much time in total at the end of the run. */
const NOTICE_SETTLE_MS = 5_000;

/**
 * The peer seat runs this on a `RESET-REQUEST`. It finds the requester by its seat labels. A failed handoff check
 * asks for a rewrite, at most 3 times per request, and then tells the requester to continue without a reset. A
 * valid handoff gets the recorded action, `/compact` or `/clear`; the resume prompt goes out only after the
 * new-session signal. A missing signal after `/clear` types `/clear` again; a missing signal after `/compact` ends
 * the run, and auto-compaction stays as the net. A missing answer to the prompt sends it again. After 3 retries in
 * total the requester starts again from its seat argv in the same terminal. A `reset` request whose effective launch
 * model or effort differs from the session record starts the requester again from its seat argv instead of `/clear`
 * (#2633); `compact` never restarts. Each failure appends one entry to the
 * reset log, then posts one notice that nothing waits for. A completed request is never reset again.
 */
export async function runSeatReset(path: string, sha256: string, options: SeatResetOptions): Promise<SeatResetResult> {
  const identity = handoffIdentity(path);
  if (identity === null) throw new SeatResetError('handoff_path_invalid', 'nothing_sent', `${path} is not the handoff path of the orchestrator or advisor seat.`);
  const run = new SeatResetRun(identity, path, options);
  try {
    return { ...await run.reset(sha256), logErrors: run.logErrors };
  } catch (error) {
    if (error instanceof SeatResetError) throw new SeatResetError(error.code, error.outcome, error.message, run.logErrors);
    throw error;
  } finally {
    await run.settleNotices();
  }
}

/** One run of `seats reset` for a valid handoff path: the log, the notices and the reset steps. */
class SeatResetRun {
  readonly logErrors: string[] = [];
  private readonly notices: Promise<unknown>[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: SeatResetTimeouts;
  private readonly logPath: string;
  private request: SeatRequest | null = null;
  private requester = '';
  private caller = '';
  private prompt = '';

  constructor(private readonly identity: SeatResetIdentity, private readonly path: string, private readonly options: SeatResetOptions) {
    this.env = options.env ?? process.env;
    this.timeouts = options.timeouts ?? TIMEOUTS;
    this.logPath = seatResetLogPath(identity);
  }

  /** Appends one log entry first, then dispatches its notice without waiting. A failed write is kept for the result. */
  private record(kind: string, detail: string, extra: Record<string, unknown> = {}): void {
    const notify = this.options.notify;
    let notice: 'none' | 'dispatched' | 'not_configured' | 'config_invalid' = 'none';
    if (kind !== 'reset' && notify === undefined) notice = 'not_configured';
    else if (kind !== 'reset') {
      try { notice = readNotifyConfig(this.env) === null ? 'not_configured' : 'dispatched'; } catch { notice = 'config_invalid'; }
    }
    try {
      appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), requested_at: this.request?.requestedAt ?? null, kind, detail, notice, ...extra })}\n`);
    } catch (error) {
      this.logErrors.push(`${kind}: ${sentence(error)}`);
    }
    if (notice !== 'dispatched' || notify === undefined) return;
    this.notices.push(notify(this.env, {
      repository: this.identity.repository, kind: 'seat.reset_failed', data: { seat: this.identity.seat, failure: kind, detail, handoff: this.path },
      text: `seat reset ${kind}: ${this.identity.seat} (${detail})`,
    }));
  }

  /** Records the failure and returns the error to throw. */
  private refuse(code: SeatResetCode, outcome: SeatResetOutcome, message: string, kind: string = code): SeatResetError {
    this.record(kind, code === kind ? message : code);
    return new SeatResetError(code, outcome, message);
  }

  private count(kind: string): number {
    let lines: string[] = [];
    try { lines = readFileSync(this.logPath, 'utf8').split('\n'); } catch { /* no log yet */ }
    return lines.filter((line) => {
      try {
        const entry = JSON.parse(line) as { requested_at?: unknown; kind?: unknown };
        return entry.requested_at === this.request?.requestedAt && entry.kind === kind;
      } catch {
        return false;
      }
    }).length;
  }

  async settleNotices(): Promise<void> {
    await Promise.race([Promise.allSettled(this.notices), new Promise(resolve => setTimeout(resolve, NOTICE_SETTLE_MS).unref())]);
  }

  async reset(sha256: string): Promise<Omit<SeatResetResult, 'logErrors'>> {
    mkdirSync(seatResetDirectory(this.identity), { recursive: true, mode: 0o700 });
    try {
      const requestPath = seatResetRequestPath(this.identity);
      this.request = readRequest(this.identity);
      if (this.request === null && !existsSync(requestPath)) {
        throw this.refuse('request_missing', 'nothing_sent', `${requestPath} is missing: the Stop hook did not ask for this reset.`);
      }
      if (this.request === null) {
        // An old request without an action, or a damaged one: no action is invented. The Stop hook does not count it
        // as open, so the next crossing writes a fresh request.
        this.findRequester();
        throw this.release('request_invalid', `${requestPath} has no valid time or action, so nothing was typed`);
      }
      // A claimed request gets no message at all, not even REWRITE or NO-RESET.
      const claim = seatResetClaimPath(this.identity, this.request.requestedAt);
      if (existsSync(claim)) throw this.alreadyClaimed();
      this.findRequester();
      this.prompt = seatResumePrompt(this.identity, this.caller, this.request.action);
      this.checkHandoff(sha256);
      this.wait();
      this.claim(claim);
      // An auto-compaction or another reset after the request started a new segment: a second action would compact
      // or clear the new summary.
      if (!requestOpen(this.identity, this.request)) {
        throw this.release('request_closed', `a session segment started after the reset request of ${this.request.requestedAt}, so nothing was typed`);
      }
    } catch (error) {
      if (error instanceof SeatResetError) throw error;
      throw this.refuse('hc_failed', 'nothing_sent', `hc failed before the first typed command: ${sentence(error)}.`);
    }
    // From the first typed command on, the requester may already be reset, so a failure gives the prompt to send by hand.
    try {
      return await this.resetAndResume();
    } catch (error) {
      if (error instanceof SeatResetError && error.outcome === 'uncertain') throw error;
      throw this.refuse('resume_not_sent', 'uncertain', `${this.requester} may have got ${SEAT_RESET_COMMAND[this.request!.action]}, but not the resume prompt: ${sentence(error)}. Send it by hand: ${this.prompt}`);
    }
  }

  private alreadyClaimed(): SeatResetError {
    return this.refuse('already_claimed', 'nothing_sent', `The reset request of ${this.request!.requestedAt} is already claimed by an earlier run.`);
  }

  /** The exclusive create is the claim: a concurrent run gets EEXIST. Any other failure types nothing. */
  private claim(path: string): void {
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw this.alreadyClaimed();
      throw this.refuse('claim_failed', 'nothing_sent', `${path} could not be created: ${sentence(error)}.`);
    }
  }

  private findRequester(): void {
    const caller = this.env.HC_TERMINAL_ID;
    if (!caller) throw this.refuse('caller_unknown', 'nothing_sent', 'HC_TERMINAL_ID is not set: run the reset from the peer seat terminal.');
    const terminals = hcList({ [RH_LABEL.seat]: this.identity.seat, [RH_LABEL.repository]: this.identity.repository }, this.options);
    if (terminals.length !== 1) {
      throw this.refuse('requester_not_found', 'nothing_sent', `${terminals.length} live terminals carry repo-harness.seat=${this.identity.seat} and repo-harness.repository=${this.identity.repository}; the reset needs exactly one.`);
    }
    this.requester = terminals[0]!.address;
    if (this.requester === caller) throw this.refuse('caller_unknown', 'nothing_sent', `The ${this.identity.seat} seat cannot reset itself: run the reset from the peer seat.`);
    const peer = RESET_SEATS.find(seat => seat !== this.identity.seat)!;
    let labels: HcLabels;
    try {
      labels = hcGet(caller, this.options).labels;
    } catch (error) {
      if (!(error instanceof HerdrCoreError) || error.reason !== 'unowned') throw error;
      throw this.refuse('caller_unknown', 'nothing_sent', `${caller} has no repo-harness label; the reset of ${this.identity.seat} requires ${RH_LABEL.repository}=${this.identity.repository} and ${RH_LABEL.seat}=${peer}.`);
    }
    for (const [key, expected] of [[RH_LABEL.repository, this.identity.repository], [RH_LABEL.seat, peer]] as const) {
      if (labels[key] !== expected) {
        throw this.refuse('caller_unknown', 'nothing_sent', `${caller} carries ${key}=${labels[key] ?? '(missing)'}; the reset of ${this.identity.seat} requires the caller to carry ${key}=${expected}.`);
      }
    }
    this.caller = caller;
  }

  /** Sends one message to the requester and records it once; a refused send records only the failure. */
  private tell(kind: string, message: string, detail: string, problem: string): void {
    try {
      hcSend(this.requester, message, this.options);
    } catch (error) {
      throw this.refuse('message_not_sent', 'uncertain', `The ${kind} message to ${this.requester} failed: ${sentence(error)}. ${problem}`);
    }
    this.record(kind, detail);
  }

  /** Releases the requester with NO-RESET: it continues, and no slash command is typed. */
  private release(code: 'request_invalid' | 'request_closed', reason: string): SeatResetError {
    this.tell('no_reset', seatNoResetMessage(reason), code, `${reason}.`);
    return new SeatResetError(code, 'no_reset', `${reason}. No reset: the requester continues.`);
  }

  /** A failed check asks for a rewrite, at most 3 times per request; then the requester continues without a reset. */
  private checkHandoff(sha256: string): void {
    const problem = handoffProblem(this.path, sha256, this.request!);
    if (problem === null) return;
    const rewrites = this.count('rewrite');
    const [kind, message, outcome, result] = rewrites < SEAT_RESET_RETRIES
      ? ['rewrite', seatRewriteMessage(this.identity, problem.message, rewrites + 1), 'rewrite_requested' as const, `Rewrite ${rewrites + 1}/${SEAT_RESET_RETRIES} asked.`]
      : ['no_reset', seatNoResetMessage('the handoff failed every rewrite'), 'no_reset' as const, 'The rewrites are used up: no reset; the requester continues.'];
    this.tell(kind, message, problem.code, problem.message);
    throw new SeatResetError(problem.code, outcome, `${problem.message} ${result}`);
  }

  /**
   * A message to the waiting seat also ends its wait (#2305), so the wait goes on for the rest of the WAIT_SECONDS
   * budget; the remaining budget shrinks with the time that passed. Returns the last result, started or not.
   */
  private waitForTurn(): HcWaitResult {
    const deadline = Date.now() + WAIT_SECONDS * 1000;
    let result = hcWait(this.requester, WAIT_SECONDS, this.options);
    while (!result.ended && result.reason === 'message') {
      const seconds = Math.ceil((deadline - Date.now()) / 1000);
      if (seconds < 1) break;
      result = hcWait(this.requester, seconds, this.options);
    }
    return result;
  }

  /** Only a requester that still works after the whole budget is busy. */
  private wait(): void {
    const result = this.waitForTurn();
    if (!result.ended) throw this.refuse('requester_busy', 'nothing_sent', `${this.requester} did not end its turn in ${WAIT_SECONDS} s (${result.reason}).`);
  }

  private async poll<T>(read: () => T | null, ms: number): Promise<T | null> {
    for (const deadline = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, this.timeouts.pollMs))) {
      const value = read();
      if (value !== null || Date.now() >= deadline) return value;
    }
  }

  private waitForSession(since: number, action: SeatResetAction): Promise<NewSession | null> {
    const ms = action === 'compact' ? this.timeouts.compactSignalMs : this.timeouts.signalMs;
    return this.poll(() => newSession(this.identity, since, this.request!, action), ms);
  }

  /** Sends the prompt; true when the model sends RESUMED in the new transcript within the evidence window. */
  private async promptAnswered(session: NewSession): Promise<boolean> {
    const offset = fileSize(session.transcript);
    hcSend(this.requester, this.prompt, this.options);
    return await this.poll(() => (sentResumed(readAppended(session.transcript, offset), this.prompt, this.caller) ? true : null), this.timeouts.evidenceMs) !== null;
  }

  private done(session: NewSession, detail: 'compacted' | 'cleared' | 'relaunched' | 'restarted'): Omit<SeatResetResult, 'logErrors'> {
    this.record('reset', detail, { session_id: session.sessionId });
    return { requester: this.requester, seat: this.identity.seat, relaunched: detail === 'relaunched' || detail === 'restarted' };
  }

  /**
   * The launch of the requester when its effective model or effort differs from the session record, else null. A record
   * without a model gives null. A launch that cannot be built, or a launch under an unknown quota mode (no fresh weekly
   * reading: a missing reading is no authority to move a running seat), is logged and gives null: the reset types
   * `/clear` as before #2633, and the seat keeps its model. A fresh `seats argv` launch still uses the unknown mode.
   */
  private async modelChange(): Promise<SeatRelaunch | null> {
    const session = readSeatSession(this.identity);
    if (session === null || session.model === null) return null;
    let launch: SeatRelaunch;
    try {
      launch = await this.options.relaunch(this.identity);
    } catch (error) {
      this.record('model_check_failed', `relaunch_argv_failed: ${sentence(error)}`);
      return null;
    }
    if (!launch.modeKnown) {
      this.record('model_check_failed', 'quota_unknown: the seat account has no fresh weekly quota reading, so the seat keeps its model');
      return null;
    }
    return launch.model === session.model && launch.effort === session.effort ? null : launch;
  }

  /**
   * Types the recorded action once. No signal after `/clear` types it again; no signal after `/compact` ends the run
   * (a second `/compact` would compact a summary). No answer sends the prompt again. After 3 retries the requester is
   * relaunched.
   */
  private async resetAndResume(): Promise<Omit<SeatResetResult, 'logErrors'>> {
    const { action } = this.request!;
    const changed = action === 'reset' ? await this.modelChange() : null;
    if (changed !== null) return this.relaunch(changed);
    let since = Date.now();
    typeLine(this.requester, SEAT_RESET_COMMAND[action], this.options);
    let session: NewSession | null = null;
    // The log counts across runs; the run counts too, so an unwritable log still ends the retries.
    for (let failures = 1; ; failures += 1) {
      session ??= await this.waitForSession(since, action);
      const failure = session === null ? 'no_signal' : await this.promptAnswered(session) ? null : 'no_evidence';
      if (failure === null) return this.done(session!, action === 'compact' ? 'compacted' : 'cleared');
      this.record('resume', failure);
      if (failure === 'no_signal' && action === 'compact') {
        throw new SeatResetError('resume_not_sent', 'uncertain', `${this.requester} got /compact, but no compact session record came in ${this.timeouts.compactSignalMs / 1000} s. No second /compact: the seat continues and Claude Code auto-compaction stays as the net. If it compacts later, send: ${this.prompt}`);
      }
      if (failures > SEAT_RESET_RETRIES || this.count('resume') > SEAT_RESET_RETRIES) return this.relaunch();
      if (failure === 'no_signal') {
        since = Date.now();
        typeLine(this.requester, '/clear', this.options);
      }
    }
  }

  /** `launch` is the launch of a model change; without it the relaunch builds the launch after the retries. */
  private async relaunch(launch?: SeatRelaunch): Promise<Omit<SeatResetResult, 'logErrors'>> {
    // A relaunched process has no compaction summary, so it gets the prompt with the git and gh check.
    this.prompt = seatResumePrompt(this.identity, this.caller, 'reset');
    const stop = (detail: string, running = false): SeatResetError => {
      const next = running ? `No key was typed; its session still runs. Send it: ${this.prompt}`
        : `Start it from \`rh seats argv ${this.identity.seat} --repository-id ${this.identity.repository}\` and send: ${this.prompt}`;
      this.record('relaunch_failed', detail);
      return new SeatResetError('resume_not_sent', 'uncertain', `The relaunch of ${this.requester} failed (${detail}). ${next}`);
    };
    // The argv needs characters that hc keys cannot type, so the login shell runs it from a script. The script is
    // ready before /exit, so a failed build leaves the running session in place.
    const script = `${seatResetDirectory(this.identity)}/relaunch.sh`;
    if (!TYPABLE.test(script) || script.includes(' ')) throw stop('relaunch_path_untypable', true);
    try {
      writeFileSync(script, `${(launch ?? await this.options.relaunch(this.identity)).argv.map(shellQuote).join(' ')}\n`, { mode: 0o700 });
    } catch (error) {
      throw stop(`relaunch_argv_failed: ${sentence(error)}`, true);
    }
    const turn = this.waitForTurn();
    if (!turn.ended) throw stop('requester_busy', true);
    typeLine(this.requester, '/exit', this.options);
    if (await this.poll(() => (hcGet(this.requester, this.options).foreground?.name === 'claude' ? null : true), this.timeouts.exitMs) === null) {
      throw stop('claude_did_not_exit');
    }
    const startedAt = Date.now();
    typeLine(this.requester, `sh ${script}`, this.options);
    const session = await this.waitForSession(startedAt, 'reset');
    if (session === null) throw stop('no_signal');
    if (!await this.promptAnswered(session)) throw stop('no_evidence');
    return this.done(session, launch === undefined ? 'relaunched' : 'restarted');
  }
}
