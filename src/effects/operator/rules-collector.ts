// The server owns this loop. GET reads memory; only a collection starts a child.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROUTING_CLASSES } from '../../core/board/seats-settings';
import { seatAccountQuotas, selectSeatRoute } from '../../core/board/seat-routing';
import type { RuleStatusV1 } from '../../core/ci/rule-candidates';
import { promotionCandidate, renderPromotionPrompt } from '../../core/ci/rule-prompt';
import { decodeRulesSnapshot, OPERATOR_RULES_KIND, type RulesPromptV1, type RulesRouteV1, type RulesSnapshotV1, type RulesUnavailableReason } from '../../core/operator/rules';
import { unavailableRuntimeOverlay } from '../../core/operator/runtime-status';
import { readQuotaReport } from '../board/quota';
import { readSeatsConfiguration } from '../board/seats-configuration';
import { withoutRepositorySelectingGitEnv } from '../git/runner';
import { readRepository, replaceObservation, startObservationLoop, type ObservationClock, type RepositoryObservation } from '../observation-loop';
import { spawnRegisteredProcessGroup } from '../process-group-registry';
import { terminateProcessGroup } from '../process-group-termination';
import { readRepoHarnessRegistryStrictSnapshot } from '../repo-registry';

export const RULES_COLLECT_INTERVAL_MS = 5 * 60_000;
export const RULES_COMMAND_TIMEOUT_MS = 60_000;
const STDOUT_LIMIT = 4 * 1024 * 1024;
/** Use this installation's CLI, not an unrelated rh on PATH. */
export const RULES_CLI_ENTRY = fileURLToPath(new URL('../../cli/index.ts', import.meta.url));
export type RulesRepositoryCache =
  | { readonly state: 'ready'; readonly snapshot: RulesSnapshotV1 }
  | { readonly state: 'unavailable'; readonly reason: RulesUnavailableReason };
export type RulesProcessRunner = (argv: readonly string[], options: {
  readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeout_ms: number; readonly signal: AbortSignal;
}) => Promise<{ readonly exit_code: number; readonly stdout: string } | null>;

/** Bound time and stdout; discard stderr and stop the whole child group on close. */
export const runRulesProcess: RulesProcessRunner = (argv, options) => new Promise(resolve => {
  if (options.signal.aborted) { resolve(null); return; }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnRegisteredProcessGroup('rules-collector', () => spawn(process.execPath, [...argv], {
      cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32', windowsHide: true,
    }));
  } catch { resolve(null); return; }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let stopping = false;
  const finish = (result: Awaited<ReturnType<RulesProcessRunner>>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
    resolve(result);
  };
  const stop = () => {
    if (settled || stopping) return;
    stopping = true;
    child.stdout!.destroy();
    if (child.pid === undefined) { finish(null); return; }
    void terminateProcessGroup(child.pid, 500).catch(() => { /* already exited */ }).then(() => finish(null));
  };
  const timer = setTimeout(stop, options.timeout_ms);
  options.signal.addEventListener('abort', stop, { once: true });
  child.stdout!.on('data', (chunk: Buffer) => {
    if (stopping) return;
    bytes += chunk.length;
    if (bytes > STDOUT_LIMIT) { stop(); return; }
    chunks.push(chunk);
  });
  child.once('error', () => { if (!stopping) finish(null); });
  child.once('close', code => {
    if (!stopping) finish(code === null ? null : { exit_code: code, stdout: Buffer.concat(chunks).toString('utf8') });
  });
});

/** The five routing classes for the current seats config and quota; null when either cannot be read. */
export async function readRulesRoutes(env: NodeJS.ProcessEnv): Promise<readonly RulesRouteV1[] | null> {
  try {
    const { seats } = readSeatsConfiguration(env);
    const quota = seatAccountQuotas((await readQuotaReport(env, seats.routing.exhausted_at_or_above_used)).accounts, seats.routing);
    return ROUTING_CLASSES.map((task) => {
      const route = selectSeatRoute(task, seats, quota);
      return route.id === null
        ? { class: task, seat: null, runtime: null, model: null }
        : { class: task, seat: route.id, runtime: route.seat.runtime, model: route.seat.model };
    });
  } catch {
    // The rules stay visible; the console shows that no seat route is known.
    return null;
  }
}

/**
 * The same renderer as `rh rules promote --print-prompt`, applied to the status
 * this cycle decoded, so each prompt binds the ledger blob that the snapshot
 * shows. A dirty or invalid ledger has no prompt, as the CLI refuses then.
 */
function promotionPrompts(status: RuleStatusV1): RulesPromptV1[] {
  if (!status.ledger.valid || status.ledger.dirty) return [];
  return status.themes.flatMap(theme => theme.actions).flatMap(action => {
    const candidate = promotionCandidate(status, action.candidate_id);
    return ROUTING_CLASSES.map(route => ({ candidate_id: action.candidate_id, route, prompt: renderPromotionPrompt(candidate, route) }));
  });
}

export interface RulesCollectorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly interval_ms?: number;
  readonly timeout_ms?: number;
  readonly run_process?: RulesProcessRunner;
  readonly clock?: ObservationClock;
  /** Production reads the seats config and the quota once per cycle; only tests inject another. */
  readonly read_routes?: () => Promise<readonly RulesRouteV1[] | null>;
  /** The runtime status cache of the server. */
  readonly read_herdr?: () => 'ready' | 'unavailable';
}
export interface RulesCollectorHandle {
  readonly read: (repositoryId: string) => RulesRepositoryCache;
  readonly settled: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** One repository at a time; every cycle replaces old results, including failures. */
export function startRulesCollector(options: RulesCollectorOptions = {}): RulesCollectorHandle {
  const env = withoutRepositorySelectingGitEnv({
    ...process.env, ...options.env, NO_COLOR: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  });
  const run = options.run_process ?? runRulesProcess;
  const clock = options.clock ?? { now: () => new Date() };
  const readRoutes = options.read_routes ?? (() => readRulesRoutes(env));
  const readHerdr = options.read_herdr ?? (() => unavailableRuntimeOverlay().status);
  const collect = async (id: string, path: string, signal: AbortSignal, routes: Promise<readonly RulesRouteV1[] | null>): Promise<RulesRepositoryCache> => {
    let result;
    try {
      result = await run([RULES_CLI_ENTRY, 'rules', 'status', '--json', '--tasks', '--target', path], {
        cwd: path, env, timeout_ms: options.timeout_ms ?? RULES_COMMAND_TIMEOUT_MS, signal,
      });
    } catch { return { state: 'unavailable', reason: 'rules_command_failed' }; }
    if (result === null || (result.exit_code !== 0 && result.exit_code !== 1)) {
      return { state: 'unavailable', reason: 'rules_command_failed' };
    }
    try {
      const status = JSON.parse(result.stdout) as RuleStatusV1;
      const snapshot = decodeRulesSnapshot({
        protocol: 1, kind: OPERATOR_RULES_KIND, repository_id: id,
        collected_at: clock.now().toISOString(), status, prompts: promotionPrompts(status), routes: await routes, herdr: readHerdr(),
      });
      if (result.exit_code === 1 && snapshot.status.ledger.valid) return { state: 'unavailable', reason: 'rules_command_failed' };
      return { state: 'ready', snapshot };
    } catch {
      return { state: 'unavailable', reason: result.exit_code === 1 ? 'rules_command_failed' : 'rules_invalid' };
    }
  };
  const loop = startObservationLoop<RepositoryObservation<RulesRepositoryCache>, RulesUnavailableReason>({
    cycle: async ({ signal }) => {
      let repos;
      try { repos = readRepoHarnessRegistryStrictSnapshot({ env }).repos; }
      catch { return { state: 'observed', value: { registry: 'failed' } }; }
      const next = new Map<string, RulesRepositoryCache>();
      // One route read per cycle, in parallel with the first repository's child.
      const routes = repos.length === 0 ? Promise.resolve(null) : readRoutes();
      for (const repo of repos) {
        if (signal.aborted) return { state: 'unavailable', reason: 'rules_command_failed' };
        next.set(repo.id, await collect(repo.id, repo.path, signal, routes));
      }
      return { state: 'observed', value: { registry: 'ok', repositories: next, complete: true } };
    },
    keep: replaceObservation,
    failure: 'rules_command_failed',
    interval_ms: options.interval_ms ?? RULES_COLLECT_INTERVAL_MS,
    clock,
  });
  return Object.freeze({
    read: (id: string): RulesRepositoryCache => {
      const result = readRepository(loop.read(), id, 'rules_pending');
      return 'value' in result ? result.value : { state: 'unavailable', reason: result.reason };
    },
    settled: loop.settled,
    close: loop.close,
  });
}
