import { sha256Hex } from '../../core/evidence/sha256';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  isSeatResetAction, missingHandoffSections, seatResetRequestPath, isSeatSessionSource, seatSessionPath,
  type SeatLaunchModel, type SeatResetAction, type SeatResetIdentity, type SeatSessionSource,
} from '../../core/board/seat-reset';

const TAIL_BYTES = 1024 * 1024;

/** The context of one assistant entry: every input token that the model read for it. */
function entryContext(line: string): number | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry !== 'object' || entry === null) return null;
  const { type, isSidechain, message } = entry as { type?: unknown; isSidechain?: unknown; message?: { usage?: Record<string, unknown> } };
  const usage = message?.usage;
  if (type !== 'assistant' || isSidechain === true || typeof usage !== 'object' || usage === null) return null;
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => usage[key] ?? 0);
  return counts.every(count => Number.isSafeInteger(count)) ? (counts as number[]).reduce((sum, count) => sum + count, 0) : null;
}

export interface TranscriptUsage {
  /** The context tokens of the last assistant entry, or null when the transcript has none. */
  readonly contextTokens: number | null;
  /** The transcript file size: the measure of the reset action (#2625). */
  readonly bytes: number;
}

/**
 * The context tokens of the last assistant entry of a Claude transcript and the file size. Transcripts grow to tens
 * of MB, so it reads the tail and doubles the window until it holds a complete assistant line.
 */
export function readTranscriptUsage(path: string): TranscriptUsage {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let window = Math.min(TAIL_BYTES, size); ; window = Math.min(window * 2, size)) {
      const buffer = Buffer.alloc(window);
      readSync(fd, buffer, 0, window, size - window);
      const lines = buffer.toString('utf8').split('\n');
      // The first line of a partial window can be cut.
      for (let index = lines.length - 1; index >= (window < size ? 1 : 0); index -= 1) {
        const context = entryContext(lines[index]!);
        if (context !== null) return { contextTokens: context, bytes: size };
      }
      if (window === size) return { contextTokens: null, bytes: size };
    }
  } finally {
    closeSync(fd);
  }
}

export interface SeatResetRequestRecord {
  readonly contextTokens: number;
  readonly transcriptPath: string;
  readonly transcriptBytes: number;
  readonly action: SeatResetAction;
}

/**
 * The Stop hook records when it asked for the reset, for which transcript and with which action; the reset command
 * refuses a handoff older than this and carries out the recorded action without a second measurement.
 */
export function writeSeatResetRequest(identity: SeatResetIdentity, now: Date, request: SeatResetRequestRecord): void {
  const path = seatResetRequestPath(identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    requested_at: now.toISOString(), context_tokens: request.contextTokens, transcript_path: request.transcriptPath,
    action: request.action, transcript_bytes: request.transcriptBytes,
  })}\n`);
}

/**
 * True while a valid request for this transcript is open. The block is once per session segment; `/compact` keeps
 * the transcript path, so its SessionStart record ends the segment. An absent request, or one that `readRequest`
 * refuses (an old request without an action), is not open, so the next crossing writes a fresh request.
 */
export function seatResetRequested(identity: SeatResetIdentity, transcriptPath: string): boolean {
  const request = readRequest(identity);
  return request !== null && request.transcriptPath === transcriptPath && requestOpen(identity, request);
}

/** A request is open while no SessionStart record is newer than it: a newer record means a new session segment. */
export function requestOpen(identity: SeatResetIdentity, request: SeatRequest): boolean {
  const session = readSeatSession(identity);
  return session === null || Date.parse(session.startedAt) <= Date.parse(request.requestedAt);
}

/**
 * The SessionStart hook records each new session segment of a reset seat (`source` startup, clear or compact): the
 * reset command sends the resume prompt only after this signal. The launch model of the session lets a tier-2 reset
 * see a mode change (#2633).
 */
export function recordSeatSession(identity: SeatResetIdentity, session: SeatLaunchModel & { readonly sessionId: string | null; readonly transcriptPath: string; readonly source: SeatSessionSource }, now: Date): void {
  const path = seatSessionPath(identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ session_id: session.sessionId, transcript_path: session.transcriptPath, source: session.source, started_at: now.toISOString(),
    model: session.model, effort: session.effort })}\n`);
}

export interface SeatSessionRecord extends SeatLaunchModel {
  readonly sessionId: string | null;
  readonly transcriptPath: string;
  readonly source: SeatSessionSource;
  readonly startedAt: string;
}

/**
 * The seat session that the SessionStart hook recorded, or null when the record is missing or any field differs from what
 * `recordSeatSession` writes. A record without the launch model (the old hook) has a null model and effort.
 */
export function readSeatSession(identity: SeatResetIdentity): SeatSessionRecord | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(seatSessionPath(identity), 'utf8')); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const { session_id: sessionId, transcript_path: transcriptPath, source, started_at: startedAt, model = null, effort = null } = value as Record<string, unknown>;
  const valid = (sessionId === null || typeof sessionId === 'string') && typeof transcriptPath === 'string' && transcriptPath !== ''
    && isSeatSessionSource(source) && typeof startedAt === 'string' && isoInstant(startedAt)
    && (model === null || typeof model === 'string') && (effort === null || typeof effort === 'string');
  return valid ? { sessionId, transcriptPath, source, startedAt, model, effort } : null;
}

/** True for the exact `Date.toISOString()` form that `recordSeatSession` writes. */
function isoInstant(text: string): boolean {
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toISOString() === text;
}

type HandoffCode = 'handoff_missing' | 'handoff_stale' | 'handoff_sha256_mismatch' | 'handoff_sections_missing';

export interface SeatRequest {
  readonly requestedAt: string;
  readonly transcriptPath: string | null;
  readonly action: SeatResetAction;
}

/**
 * The one boundary validator of request.json for the Stop hook and `seats reset`. It returns a typed request only for
 * an object with a valid time and a recorded action; for any other content it returns null and never throws, so both
 * readers take their invalid-request path. Nothing chooses the action again.
 */
export function readRequest(identity: SeatResetIdentity): SeatRequest | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(seatResetRequestPath(identity), 'utf8')); } catch { return null; }
  // Any JSON value that is not a plain object (null, an array, a number, a string, a boolean) is not a request.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { requested_at: requestedAt, transcript_path: transcriptPath, action } = value as Record<string, unknown>;
  if (typeof requestedAt !== 'string' || !Number.isFinite(Date.parse(requestedAt)) || !isSeatResetAction(action)) return null;
  return { requestedAt, transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null, action };
}

/** The first failed check of the handoff of a `RESET-REQUEST`, or null when it passes. */
export function handoffProblem(path: string, sha256: string, request: SeatRequest): { readonly code: HandoffCode; readonly message: string } | null {
  if (!existsSync(path)) return { code: 'handoff_missing', message: `${path} does not exist.` };
  if (statSync(path).mtimeMs <= Date.parse(request.requestedAt)) return { code: 'handoff_stale', message: `${path} is older than the reset request of ${request.requestedAt}.` };
  const text = readFileSync(path);
  const actual = sha256Hex(text);
  if (actual !== sha256.toLowerCase()) return { code: 'handoff_sha256_mismatch', message: `${path} has sha256 ${actual}, not ${sha256}.` };
  const missing = missingHandoffSections(text.toString('utf8'));
  return missing.length === 0 ? null : { code: 'handoff_sections_missing', message: `${path} has no section ${missing.map(section => `"## ${section}"`).join(', ')}.` };
}

export interface NewSession {
  readonly transcript: string;
  readonly sessionId: string | null;
}

/**
 * The session segment that started at or after `since`: for `/compact` a `compact` record of the transcript of the
 * request, for `/clear` and a relaunch a record of another transcript.
 */
export function newSession(identity: SeatResetIdentity, since: number, request: SeatRequest, action: SeatResetAction): NewSession | null {
  const session = readSeatSession(identity);
  if (session === null || Date.parse(session.startedAt) < since) return null;
  const segment = action === 'compact'
    ? session.source === 'compact' && session.transcriptPath === request.transcriptPath
    : session.transcriptPath !== request.transcriptPath;
  return segment ? { transcript: session.transcriptPath, sessionId: session.sessionId } : null;
}

/** The bytes of a file after `offset`, or '' when it is missing; the evidence poll reads only what was appended. */
export function readAppended(path: string, offset: number): string {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return ''; }
  try {
    const length = Math.max(0, fstatSync(fd).size - offset);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export const fileSize = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };

const RESUMED_WORDS: readonly string[] = ['RESUMED', "'RESUMED'", '"RESUMED"'];

/**
 * Only the one simple command `hc send <peer> RESUMED` counts, with the message bare or in plain quotes. A compound,
 * piped, background or substituted command, another address and a command that only prints the text all fail the
 * word compare.
 */
function isResumedSend(command: string, peer: string): boolean {
  const words = command.trim().split(/[ \t]+/u);
  return words.length === 4 && words[0] === 'hc' && words[1] === 'send' && words[2] === peer && RESUMED_WORDS.includes(words[3]!);
}

type Part = { type?: unknown; name?: unknown; text?: unknown; id?: unknown; tool_use_id?: unknown; is_error?: unknown; input?: { command?: unknown } } | null;

/** The fields that the resume evidence reads from one transcript line. */
interface TranscriptLine {
  readonly type: unknown;
  /** `message.content`: the prompt text, or the parts, of the entry. */
  readonly content: unknown;
  /** `attachment` of the entry: a prompt that arrives during a turn comes as a queued command here. */
  readonly attachment: { readonly type: unknown; readonly prompt: unknown } | null;
}

/**
 * The evidence fields of one transcript line, or null for a line that is not a JSON object: a JSON null, an array, a
 * scalar and a cut line are skipped, never a throw.
 */
function transcriptLine(line: string): TranscriptLine | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { type, message, attachment } = entry as { type?: unknown; message?: { content?: unknown } | null; attachment?: unknown };
  const queued = typeof attachment === 'object' && attachment !== null ? attachment as { type?: unknown; prompt?: unknown } : null;
  return { type, content: message?.content, attachment: queued === null ? null : { type: queued.type, prompt: queued.prompt } };
}

/**
 * True when the line holds the resume prompt: a user entry, which hc may wrap, or the `queued_command` attachment of an
 * `attachment` entry, which Claude Code writes when the prompt arrives while the session is in a turn (#2637). The entry
 * type must be `attachment`, so an assistant line that carries an `attachment` field of its own is no prompt.
 */
function holdsPrompt(entry: TranscriptLine, parts: readonly Part[], prompt: string): boolean {
  const holds = (value: unknown) => typeof value === 'string' && value.includes(prompt);
  const queued = entry.type === 'attachment' && entry.attachment !== null && entry.attachment.type === 'queued_command'
    && holds(entry.attachment.prompt);
  return queued || (entry.type === 'user' && (holds(entry.content) || parts.some(part => holds(part?.text))));
}

/**
 * Mechanical resume evidence in the text appended after the prompt send: the entry that holds the resume prompt, then
 * an assistant Bash tool call whose command sends RESUMED to the peer with hc send, then its tool result without an
 * error. A refused, failed or missing result is no evidence.
 */
export function sentResumed(appended: string, prompt: string, peer: string): boolean {
  let asked = false;
  const sends = new Set<unknown>();
  for (const line of appended.split('\n')) {
    const entry = transcriptLine(line);
    if (entry === null) continue;
    const parts = Array.isArray(entry.content) ? entry.content as Part[] : [];
    if (entry.type === 'user' && parts.some(part => part?.type === 'tool_result' && sends.has(part.tool_use_id) && part.is_error !== true)) return true;
    if (holdsPrompt(entry, parts, prompt)) asked = true;
    if (!asked || entry.type !== 'assistant') continue;
    for (const part of parts) {
      const command = part?.type === 'tool_use' && part.name === 'Bash' ? part.input?.command : undefined;
      if (typeof command === 'string' && isResumedSend(command, peer)) sends.add(part!.id);
    }
  }
  return false;
}
