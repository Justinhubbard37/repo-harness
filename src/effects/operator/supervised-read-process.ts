import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../core/evidence/sha256';
import { spawnRegisteredProcessGroup } from '../process-group-registry';
import { terminateProcessGroup, type ProcessGroupTermination } from '../process-group-termination';
import { jsonHeaders, sendJson } from './http-helpers';
import type { OperatorServerOptions } from './server';

const OPERATOR_WORKER_CLEANUP_GRACE_MS = 500;
const OPERATOR_JOB_CONTROLLER_ACK_TIMEOUT_MS = 5_000;

// Observation children are read-only. Git must not fetch promised objects,
// take optional locks or prompt. Apply these last so caller values cannot reopen them.
export const OPERATOR_READ_ONLY_GIT_ENVIRONMENT = { GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } as const;

export function repositoryWorkerEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

type WindowsJobControllerResponse =
  | { readonly type: 'assigned' }
  | { readonly type: 'cleanup_ack' }
  | { readonly type: 'cleanup_failed' };

function windowsJobControllerResponse(value: unknown): WindowsJobControllerResponse | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'cleanup_ack' || record.type === 'cleanup_failed') return { type: record.type };
  if (record.type === 'assigned') return { type: 'assigned' };
  return null;
}

function writeChildJsonLine(child: ChildProcessWithoutNullStreams, value: unknown): boolean {
  if (child.stdin.destroyed || !child.stdin.writable) return false;
  try {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    return true;
  } catch {
    return false;
  }
}

function childJsonLines(stream: NodeJS.ReadableStream, onValue: (value: unknown) => void): void {
  let buffered = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try { onValue(JSON.parse(line)); } catch { onValue(null); }
      newline = buffered.indexOf('\n');
    }
  });
}

// A collector without a PID or a signal failure cannot prove the group exited.
const UNCONFIRMED_COLLECTOR_TERMINATION: ProcessGroupTermination = { confirmed: false, forced: true };

function terminateCollectorProcessGroup(pid: number | undefined): Promise<ProcessGroupTermination> {
  if (pid === undefined) return Promise.resolve(UNCONFIRMED_COLLECTOR_TERMINATION);
  return terminateProcessGroup(pid, OPERATOR_WORKER_CLEANUP_GRACE_MS, {
    confirmMs: OPERATOR_JOB_CONTROLLER_ACK_TIMEOUT_MS,
  }).catch(() => UNCONFIRMED_COLLECTOR_TERMINATION);
}

function windowsJobControllerPath(): string {
  return fileURLToPath(new URL('../../../assets/operator/windows-job-controller.ps1', import.meta.url));
}

/** A supervised read that was aborted or outlived its grace period; callers report it as unavailable. */
class OperatorReadCancelledError extends Error {
  constructor() { super('operator read cancelled'); }
}

class OperatorTaskReadError extends Error {
  constructor(readonly code: string) { super(code); }
}

type SupervisedReadResponse<T> =
  | { readonly ok: true; readonly snapshot: T }
  | { readonly ok: false; readonly code: string }
  | { readonly ok: false; readonly cancelled: true };

/**
 * POSIX reads run in a server-owned, registered detached process group. On
 * Windows the server owns only the Job controller child; that Job owner
 * creates the inert read process and assigns its exact handle before it
 * forwards the start payload. Descendants then inherit the Job.
 */
function readSupervisedOperatorProcess<T>(input: {
  readonly process_path: string;
  readonly start: Readonly<Record<string, unknown>>;
  readonly response: (value: unknown) => SupervisedReadResponse<T> | null;
  readonly failure: (code: string) => Error;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<T> {
  if (input.signal.aborted) return Promise.reject(new OperatorReadCancelledError());
  return new Promise((resolveRead, rejectRead) => {
    const workerEnvironment = { ...process.env, ...repositoryWorkerEnvironment(input.env), ...OPERATOR_READ_ONLY_GIT_ENVIRONMENT };
    const collector = process.platform === 'win32'
      ? null
      : spawnRegisteredProcessGroup('operator-collector', () => spawn(process.execPath, [input.process_path], {
        env: workerEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      }));
    const controller = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsJobControllerPath()], {
        env: workerEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      : null;
    let settled = false;
    let cancellationRequested = false;
    let collectorClosed = false;
    let controllerAssigned = controller === null;
    let controllerClosed = controller === null;
    let controllerFailed = false;
    let controllerCleanupAcknowledged = controller === null;
    let controllerCleanupRequested = false;
    let collectorResponse: SupervisedReadResponse<T> | null = null;
    let intended: { readonly ok: true; readonly snapshot: T } | { readonly ok: false; readonly error: unknown } | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let acknowledgementTimer: ReturnType<typeof setTimeout> | null = null;
    let controllerCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let posixFinalizing = false;
    let posixCancellationPending = false;
    const finish = (
      outcome:
        | { readonly ok: true; readonly snapshot: T }
        | { readonly ok: false; readonly error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      if (acknowledgementTimer !== null) clearTimeout(acknowledgementTimer);
      if (controllerCloseTimer !== null) clearTimeout(controllerCloseTimer);
      collector?.stdin.end();
      controller?.stdin.end();
      if (outcome.ok) resolveRead(outcome.snapshot);
      else rejectRead(outcome.error);
    };
    const unavailable = (message: string) => new Error(message);
    const failWindowsController = (message: string): void => {
      if (settled || controller === null || controllerFailed) return;
      controllerFailed = true;
      intended = { ok: false, error: unavailable(message) };
      cancellationRequested = true;
      if (acknowledgementTimer !== null) {
        clearTimeout(acknowledgementTimer);
        acknowledgementTimer = null;
      }
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      try { controller.kill('SIGKILL'); } catch { /* controller close remains the cleanup fence */ }
    };
    const requestWindowsCleanup = (terminate: boolean): void => {
      if (controller === null || controllerCleanupRequested || settled) return;
      controllerCleanupRequested = true;
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      if (!writeChildJsonLine(controller, { type: terminate ? 'terminate' : 'cleanup' })) {
        failWindowsController('Windows Job controller is unavailable');
        return;
      }
      acknowledgementTimer = setTimeout(() => {
        failWindowsController('Windows Job controller did not acknowledge cleanup');
      }, OPERATOR_JOB_CONTROLLER_ACK_TIMEOUT_MS);
    };
    const finalizePosix = (): void => {
      if (settled || collector === null || !collectorClosed || intended === null || posixFinalizing) return;
      posixFinalizing = true;
      const outcome = intended;
      void terminateCollectorProcessGroup(collector.pid).then((termination) => {
        if (!termination.confirmed) finish({ ok: false, error: unavailable('Read process process group did not exit') });
        else finish(outcome);
      });
    };
    const finalize = (): void => {
      if (controller !== null) {
        if (controllerFailed) {
          if (controllerClosed && intended !== null) finish(intended);
          return;
        }
        if (intended === null) return;
        if (!controllerAssigned) {
          failWindowsController('Windows Job controller returned a collector response before assignment');
          return;
        }
        if (!controllerCleanupRequested) requestWindowsCleanup(cancellationRequested);
        if (controllerCleanupAcknowledged && controllerClosed) finish(intended);
        return;
      }
      if (collector === null || !collectorClosed) return;
      if (intended === null) intended = { ok: false, error: unavailable('Read process exited without a response') };
      if (posixCancellationPending) return;
      finalizePosix();
    };
    const recordCollectorResponse = (value: unknown): void => {
      const response = input.response(value);
      if (response === null) {
        intended = { ok: false, error: unavailable('Read process returned an invalid response') };
      } else if (response.ok) {
        collectorResponse = response;
        intended = cancellationRequested
          ? { ok: false, error: new OperatorReadCancelledError() }
          : { ok: true, snapshot: response.snapshot };
      } else if ('cancelled' in response) {
        collectorResponse = response;
        intended = { ok: false, error: new OperatorReadCancelledError() };
      } else {
        collectorResponse = response;
        intended = { ok: false, error: input.failure(response.code) };
      }
      finalize();
    };
    const onAbort = (): void => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      if (controller !== null) {
        if (!writeChildJsonLine(controller, { type: 'cancel' })) {
          failWindowsController('Windows Job controller cannot accept cooperative cancellation');
          return;
        }
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          intended = { ok: false, error: new OperatorReadCancelledError() };
          requestWindowsCleanup(true);
        }, OPERATOR_WORKER_CLEANUP_GRACE_MS);
        return;
      }
      if (collector === null || !writeChildJsonLine(collector, { type: 'cancel' })) {
        intended = { ok: false, error: unavailable('Read process cannot accept cooperative cancellation') };
      }
      if (collector === null) return;
      posixCancellationPending = true;
      void terminateCollectorProcessGroup(collector.pid).then((termination) => {
        posixCancellationPending = false;
        // A collector that outlives the cooperative grace period has timed out,
        // whatever it reported before the forced kill.
        if (termination.forced) intended = { ok: false, error: new OperatorReadCancelledError() };
        if (!termination.confirmed) finish({ ok: false, error: unavailable('Read process process group did not exit') });
        else finalize();
      });
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (collector !== null) {
      childJsonLines(collector.stdout, recordCollectorResponse);
      collector.stderr.resume();
      collector.once('error', (error) => {
        intended = { ok: false, error: unavailable(`Read process failed: ${error.message}`) };
      });
      collector.once('close', () => {
        collectorClosed = true;
        if (collectorResponse === null && intended === null) intended = { ok: false, error: unavailable('Read process exited without a response') };
        finalize();
      });
    }
    if (controller !== null) {
      childJsonLines(controller.stdout, (value) => {
        const response = windowsJobControllerResponse(value);
        if (response === null) {
          recordCollectorResponse(value);
          return;
        }
        if (response.type === 'assigned') {
          if (controllerAssigned) {
            failWindowsController('Windows Job controller assigned more than one collector');
            return;
          }
          controllerAssigned = true;
          if (cancellationRequested) return;
          if (!writeChildJsonLine(controller, input.start)) {
            intended = { ok: false, error: unavailable('Windows Job controller cannot forward the assigned start payload') };
            requestWindowsCleanup(true);
          }
          return;
        }
        if (response.type === 'cleanup_ack') {
          controllerCleanupAcknowledged = true;
          if (acknowledgementTimer !== null) {
            clearTimeout(acknowledgementTimer);
            acknowledgementTimer = null;
          }
          controllerCloseTimer = setTimeout(() => {
            failWindowsController('Windows Job controller did not exit after cleanup acknowledgement');
          }, OPERATOR_JOB_CONTROLLER_ACK_TIMEOUT_MS);
          finalize();
          return;
        }
        failWindowsController('Windows Job controller could not prove cleanup');
      });
      controller.stderr.resume();
      controller.once('error', (error) => {
        failWindowsController(`Windows Job controller failed: ${error.message}`);
      });
      controller.once('close', () => {
        controllerClosed = true;
        if (controllerCloseTimer !== null) {
          clearTimeout(controllerCloseTimer);
          controllerCloseTimer = null;
        }
        if (!controllerCleanupAcknowledged && !settled) {
          failWindowsController('Windows Job controller exited without cleanup acknowledgement');
        }
        finalize();
      });
      if (!writeChildJsonLine(controller, {
        type: 'launch',
        executable: process.execPath,
        collector_path: input.process_path,
      })) {
        failWindowsController('Windows Job controller cannot accept collector launch');
      }
    } else if (collector !== null && !writeChildJsonLine(collector, input.start)) {
      finish({ ok: false, error: unavailable('Read process cannot accept start payload') });
    }
    if (input.signal.aborted) {
      onAbort();
    }
  });
}

export function createBoundedTaskReadHandler(
  options: Pick<OperatorServerOptions, 'env'>,
  maxConcurrency: number,
  timeoutMs: number,
  activeTaskReadCancellers: Set<() => void>,
  activeTaskReadCompletions: Set<Promise<void>>,
  isClosed: () => boolean,
) {
  const handleBoundedTaskRead = <TRequest extends object, TSnapshot>(
    response: ServerResponse, headOnly: boolean, input: TRequest,
    decode: (value: unknown, request: TRequest) => TSnapshot,
    failures: readonly string[], kind: 'architecture' | 'task_messages',
    injected?: (request: TRequest & { readonly signal: AbortSignal }) => Promise<TSnapshot>,
    failureStatus: (failure: string) => number = failure => failure === 'history_unavailable' || failure === 'task_not_found' ? 404 : failure === 'stale' ? 409 : failure === 'too_large' ? 413 : 503,
    cacheRequest?: IncomingMessage,
    readTimeoutMs = timeoutMs,
  ): void => {
    if (isClosed()) { sendJson(response,503,{code:'unavailable'},headOnly); return; }
    if (activeTaskReadCancellers.size >= maxConcurrency) { sendJson(response,503,{code:'busy'},headOnly); return; }
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => finish('unavailable');
    const release = () => activeTaskReadCancellers.delete(cancel);
    const finish = (failure?: string, snapshot?: TSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      response.removeListener('close',cancel);
      if (response.destroyed) return;
      if (failure) sendJson(response, failureStatus(failure),{code:failure},headOnly);
      else if (cacheRequest) {
        const etag = `"${sha256Hex(JSON.stringify(snapshot))}"`;
        if (cacheRequest.headers['if-none-match'] === etag) {
          response.writeHead(304, { ...jsonHeaders(), ETag: etag }); response.end();
        } else sendJson(response, 200, snapshot, headOnly, { ETag: etag });
      } else sendJson(response,200,snapshot,headOnly);
    };
    const accept = (value: unknown) => {
      try { finish(undefined,decode(value,input)); }
      catch { finish('unavailable'); }
    };
    activeTaskReadCancellers.add(cancel);
    response.once('close',cancel);
    timer = setTimeout(()=>finish('timeout'),readTimeoutMs);
    const pending = injected
      ? Promise.resolve().then(()=>{
        if (controller.signal.aborted) throw new OperatorTaskReadError('unavailable');
        return injected({...input,signal:controller.signal});
      })
      : readSupervisedOperatorProcess<TSnapshot>({
        process_path:fileURLToPath(new URL('./task-read-process.ts',import.meta.url)),
        env:options.env,
        signal:controller.signal,
        start:{type:'start',protocol:1,kind,request:input,env:repositoryWorkerEnvironment(options.env)},
        response:value=>{
          if (!value || typeof value !== 'object') return null;
          const record=value as Record<string,unknown>;
          if (record.ok === true && Object.keys(record).length === 2 && 'snapshot' in record) {
            try { return {ok:true,snapshot:decode(record.snapshot,input)}; } catch { return null; }
          }
          if (record.ok === false && Object.keys(record).length === 2 && typeof record.code === 'string' && failures.includes(record.code)) {
            return {ok:false,code:record.code};
          }
          if (record.ok === false && Object.keys(record).length === 2 && record.cancelled === true) return {ok:false,cancelled:true};
          return null;
        },
        failure:code=>new OperatorTaskReadError(code),
      });
    // The supervisor settles only after process-tree cleanup, including blocked sync Git.
    const completion = pending.then(accept,error=>finish(error instanceof OperatorTaskReadError ? error.code : 'unavailable')).finally(release);
    activeTaskReadCompletions.add(completion);
    void completion.finally(()=>activeTaskReadCompletions.delete(completion));
  };

  return handleBoundedTaskRead;
}
