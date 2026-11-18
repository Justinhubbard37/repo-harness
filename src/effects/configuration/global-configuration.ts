import { sha256Prefixed } from '../../core/evidence/sha256';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { requireHome } from '../repo-harness-home';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retryWindowsSharingRace, syncDirectoryDurably } from '../atomic-append';
import { ExclusiveLockContentionError } from '../locking/exclusive-directory-lock';
import { assertRuntimeTransactionContext, globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../locking/runtime-transaction-lock';
import type { GlobalConfigurationWrite } from '../../core/architecture/contracts';

export class GlobalConfigurationError extends Error {
  constructor(readonly code: 'config_invalid' | 'config_is_link' | 'revision_conflict' | 'busy', message: string) {
    super(message);
    this.name = 'GlobalConfigurationError';
  }
}

export function globalConfigurationPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = requireHome(env);
  if (!isAbsolute(home)) throw new Error('global configuration requires an absolute HOME');
  return join(home, '.repo-harness', 'config.json');
}

/** The digest of the exact file bytes, or `absent` when there is no file. */
export function globalConfigurationRevision(bytes: Buffer | null): string {
  return bytes === null ? 'absent' : sha256Prefixed(bytes);
}

function assertWritableConfiguration(path: string): void {
  for (const [entry, directory] of [[dirname(path), true], [path, false]] as const) {
    try {
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) throw new GlobalConfigurationError('config_is_link', 'The repo-harness configuration path is a symbolic link. Writes require a regular file in a real directory.');
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new GlobalConfigurationError('config_invalid', 'The repo-harness configuration path has an invalid file type.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function replaceGlobalConfiguration(path: string, bytes: Buffer | null, assertOwned: () => void): void {
  assertWritableConfiguration(path);
  const directory = dirname(path);
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) syncDirectoryDurably(dirname(directory));
  if (bytes === null) {
    assertOwned();
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    syncDirectoryDurably(directory);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) throw new Error('configuration was only partly written');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    assertOwned();
    assertWritableConfiguration(path);
    retryWindowsSharingRace(() => renameSync(temporary, path));
    syncDirectoryDurably(directory);
  } finally { rmSync(temporary, { force: true }); }
}

/** Restore the exact installer preimage while its original transaction is still held. */
export function restoreGlobalConfiguration(path: string, bytes: Buffer | null, runtimeLock: RuntimeTransactionContext): void {
  if (path !== join(dirname(dirname(path)), '.repo-harness', 'config.json')) throw new Error('invalid configuration snapshot path');
  const scope = globalRuntimeScope({ HOME: dirname(dirname(path)) });
  assertRuntimeTransactionContext(runtimeLock, scope);
  if (bytes !== null) {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GlobalConfigurationError('config_invalid', 'The configuration preimage is not a valid JSON object.');
  }
  replaceGlobalConfiguration(path, bytes, () => assertRuntimeTransactionContext(runtimeLock, scope));
}

/** All product writers join the install transaction lock before reading this document. */
export function mutateGlobalConfiguration<T>(
  env: NodeJS.ProcessEnv,
  mutate: (config: Record<string, unknown>) => { readonly config?: Record<string, unknown> | null; readonly value: T },
  options: {
    readonly expectedRevision?: string;
    readonly runtimeLock?: RuntimeTransactionContext;
    /** Render the next document from the current text, so a caller that removes one member keeps every other byte. Default: `JSON.stringify(config, null, 2)`. */
    readonly render?: (text: string, next: Record<string, unknown>) => string;
    /** Runs under the lock, only before replacing an existing document with different bytes. A failure prevents the write. */
    readonly beforeWrite?: (path: string, text: string) => void;
  } = {},
): { readonly path: string; readonly revision: string; readonly changed: boolean; readonly value: T } {
  const scope = globalRuntimeScope(env);
  try {
    return withRuntimeTransactionContext(scope, options.runtimeLock, (context) => {
      assertRuntimeTransactionContext(context, scope);
      const path = globalConfigurationPath(env);
      assertWritableConfiguration(path);
      let document: ReturnType<typeof readGlobalConfiguration>;
      try { document = readGlobalConfiguration(env); }
      catch (error) {
        if (error instanceof GlobalConfigurationError) throw error;
        throw new GlobalConfigurationError('config_invalid', 'The repo-harness configuration file is not a valid JSON object.');
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== document.revision) {
        throw new GlobalConfigurationError('revision_conflict', 'The configuration changed after it was read.');
      }
      const next = mutate(document.config);
      if (next.config === undefined) return { path, revision: document.revision, changed: false, value: next.value };
      const bytes = next.config === null ? null
        : Buffer.from(options.render ? options.render(document.text, next.config) : `${JSON.stringify(next.config, null, 2)}\n`, 'utf8');
      const revision = globalConfigurationRevision(bytes);
      if (revision === document.revision) return { path, revision, changed: false, value: next.value };
      if (document.revision !== 'absent') options.beforeWrite?.(path, document.text);
      replaceGlobalConfiguration(path, bytes, () => assertRuntimeTransactionContext(context, scope));
      return { path, revision, changed: true, value: next.value };
    }, { waitTimeoutMs: 1 });
  } catch (error) {
    if (error instanceof ExclusiveLockContentionError) throw new GlobalConfigurationError('busy', 'A runtime transaction is changing configuration. Nothing was changed. Retry after it ends.');
    throw error;
  }
}

/** Whether the host configuration has an `architecture` section. Core reads only its presence; the architecture plugin validates it. */
export function globalArchitectureSectionPresent(env: NodeJS.ProcessEnv = process.env): { readonly path: string; readonly present: boolean } {
  const { path, config } = readGlobalConfiguration(env);
  return { path, present: config.architecture !== undefined };
}

/** The write callback that core gives a plugin configuration owner: each change runs under `runtimeLock`, or under its own lock. */
export function globalConfigurationWriter(env: NodeJS.ProcessEnv, runtimeLock?: RuntimeTransactionContext): GlobalConfigurationWrite {
  return <T>(mutate: (config: Record<string, unknown>) => { readonly config?: Record<string, unknown> | null; readonly value: T }): T =>
    mutateGlobalConfiguration(env, mutate, { runtimeLock }).value;
}

/** JSON.parse owns syntax validation; scan its valid input for repeated names in each object. */
function assertUniqueConfigurationMembers(text: string): void {
  const objects: Set<string>[] = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (match[0] === '{') objects.push(new Set());
    else if (match[0] === '}') objects.pop();
    else if (match[1]) {
      const key = JSON.parse(match[0].slice(0, -match[1].length)) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new GlobalConfigurationError('config_invalid', 'The repo-harness configuration file has duplicate member names. Nothing was changed.');
      keys.add(key);
    }
  }
}

/** One host configuration document; typed consumers validate their own section. */
export function readGlobalConfiguration(env: NodeJS.ProcessEnv = process.env): { path: string; config: Record<string, unknown>; revision: string; text: string } {
  const path = globalConfigurationPath(env);
  let bytes: Buffer | null = null;
  let text = '{}';
  let value: unknown;
  try {
    bytes = readFileSync(path);
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new GlobalConfigurationError('config_invalid', 'The repo-harness configuration file contains invalid UTF-8. Nothing was changed.'); }
    value = JSON.parse(text);
    assertUniqueConfigurationMembers(text);
  } catch (error) {
    if (error instanceof GlobalConfigurationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid global configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    value = {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Global configuration must be an object: ${path}`);
  return { path, config: value as Record<string, unknown>, revision: globalConfigurationRevision(bytes), text };
}
