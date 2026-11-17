import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import {
  EMPTY_LEDGER,
  HostConfigError,
  matchesExpected,
  type ExpectedFile,
  type FileObservation,
  type HostConfigLedger,
  type HostPath,
  type Sha256,
} from '../../core/host-config/types';
import { publishFileByRename, retryWindowsSharingRace } from '../atomic-append';
import { globalConfigurationPath } from '../configuration/global-configuration';
import { isPathInside } from '../path-containment';

/** Storage beside the global configuration file: `~/.repo-harness/config/`. */
export interface HostConfigPaths {
  /** `~/.repo-harness/` with links followed: no host target may lie inside it. */
  readonly harness: string;
  readonly root: string;
  readonly ledger: string;
  readonly vault: string;
}

function invalidState(message: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', message);
}

/** Bounds a chain of dangling links, as the kernel bounds a link chain. */
const MAX_LINK_HOPS = 40;

/**
 * Follow the user's links: `realpathSync.native` of the deepest existing
 * ancestor, plus the missing tail. A dangling link is followed to the path it
 * names, where the write then creates the file.
 */
function followLinks(path: string, hops = 0): string {
  const missing: string[] = [];
  let current = path;
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  try { return join(realpathSync.native(current), ...missing); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || hops >= MAX_LINK_HOPS) throw error;
    return followLinks(join(resolve(dirname(current), readlinkSync(current)), ...missing), hops + 1);
  }
}

export function hostConfigPaths(env: NodeJS.ProcessEnv): HostConfigPaths {
  const harness = followLinks(dirname(globalConfigurationPath(env)));
  const root = join(harness, 'config');
  return { harness, root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault') };
}

/** The one boundary for a host path: links followed, and refused inside `~/.repo-harness/`. */
export function resolveHostPath(paths: HostConfigPaths, path: unknown): HostPath {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new HostConfigError('host_config_invalid_path', `not an absolute path: ${String(path)}`);
  const resolved = followLinks(resolve(path));
  if (isPathInside(paths.harness, resolved)) throw new HostConfigError('host_config_invalid_path', `rh does not write host configuration inside ${paths.harness}: ${path}`);
  return resolved as HostPath;
}

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function observeFile(path: string): { readonly observation: FileObservation; readonly bytes: Buffer | null } {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { observation: { existed: false }, bytes: null };
  if (stat.isSymbolicLink()) return { observation: { existed: true, type: 'symlink' }, bytes: null };
  if (stat.isDirectory()) return { observation: { existed: true, type: 'directory' }, bytes: null };
  if (!stat.isFile()) return { observation: { existed: true, type: 'other' }, bytes: null };
  const bytes = readFileSync(path);
  return { observation: { existed: true, type: 'file', sha256: sha256Prefixed(bytes) }, bytes };
}

export function expectedOf(observation: FileObservation, path: string): ExpectedFile {
  if (!observation.existed) return { existed: false };
  if (observation.type !== 'file') throw invalidState(`not a regular file: ${path}`);
  return { existed: true, sha256: observation.sha256 };
}

/**
 * Replace the target by a `wx` temporary file beside it and a rename. The
 * target must still match `expected` right before the rename, so rh never
 * overwrites a change that it did not see. An existing file keeps its mode.
 */
export function replaceTarget(path: HostPath, bytes: Buffer, expected: ExpectedFile): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const mode = lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0o600;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) throw invalidState(`partial write: ${path}`);
      fchmodSync(fd, mode & 0o777);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (!matchesExpected(observeFile(path).observation, expected)) {
      throw new HostConfigError('host_config_target_changed', `the target changed before the write: ${path}`);
    }
    retryWindowsSharingRace(() => renameSync(temporary, path));
  } finally { rmSync(temporary, { force: true }); }
}

export function removeTarget(path: HostPath, expected: ExpectedFile): void {
  if (!matchesExpected(observeFile(path).observation, expected)) {
    throw new HostConfigError('host_config_target_changed', `the target changed before the removal: ${path}`);
  }
  retryWindowsSharingRace(() => unlinkSync(path));
}

/** The missing ancestors of the target, outermost first. */
export function missingDirectories(path: HostPath): string[] {
  const missing: string[] = [];
  for (let current = dirname(path); !lstatSync(current, { throwIfNoEntry: false }); current = dirname(current)) missing.unshift(current);
  return missing;
}

export function createDirectories(directories: readonly string[]): void {
  for (const directory of directories) mkdirSync(directory, { mode: 0o700 });
}

/** Remove the directories rh created, innermost first, and return those that still hold other content. */
export function removeCreatedDirectories(directories: readonly string[]): string[] {
  const kept: string[] = [];
  for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') kept.push(directory);
      else if (code !== 'ENOENT') throw error;
    }
  }
  return kept;
}

// ---- ledger -------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value: unknown): value is Sha256 => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const isText = (value: unknown): value is string => typeof value === 'string';

function validBaseline(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === 'unknown') return true;
  return value.state === 'known' && (value.existed === false || (value.existed === true && isSha(value.sha256)));
}

function validFileRecord(record: unknown): boolean {
  if (!isObject(record) || !isObject(record.committed)) return false;
  const committed = record.committed;
  return ['created', 'text_block', 'replaced'].includes(record.kind as string) && validBaseline(record.baseline)
    && (committed.type === 'absent' || (committed.type === 'file' && isSha(committed.sha256)))
    && (isSha(record.backup) || (record.backup === null && record.kind === 'created'))
    && typeof record.external_change === 'boolean';
}

function validFragment(value: unknown): boolean {
  return isObject(value) && isText(value.file) && isText(value.owner) && isText(value.selector)
    && ['add', 'refresh', 'override'].includes(value.kind as string) && isText(value.inserted);
}

export function readLedger(paths: HostConfigPaths): HostConfigLedger {
  const { observation, bytes } = observeFile(paths.ledger);
  if (!observation.existed) return EMPTY_LEDGER;
  if (bytes === null) throw invalidState(`the ledger is not a regular file: ${paths.ledger}`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw invalidState(`the ledger is not valid JSON: ${paths.ledger}`); }
  const valid = isObject(value) && value.protocol === 1
    && isObject(value.files) && Object.entries(value.files).every(([path, record]) => isAbsolute(path) && validFileRecord(record))
    && Array.isArray(value.fragments) && value.fragments.every(validFragment)
    && Array.isArray(value.directories) && value.directories.every((directory) => isText(directory) && isAbsolute(directory));
  if (!valid) throw invalidState(`the ledger has an invalid shape: ${paths.ledger}`);
  return value as unknown as HostConfigLedger;
}

export function writeLedger(paths: HostConfigPaths, ledger: HostConfigLedger): void {
  publishFileByRename(paths.ledger, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8'), `${paths.ledger}.${randomUUID()}.tmp`);
}

// ---- vault --------------------------------------------------------------

/** Content-addressed and shared: a second put of the same bytes reuses the stored copy. */
export function putVault(paths: HostConfigPaths, bytes: Buffer): Sha256 {
  const hex = sha256Hex(bytes);
  const target = join(paths.vault, hex);
  if (!lstatSync(target, { throwIfNoEntry: false })) publishFileByRename(target, bytes, `${target}.${randomUUID()}.tmp`);
  readVault(paths, `sha256:${hex}`);
  return `sha256:${hex}`;
}

export function readVault(paths: HostConfigPaths, reference: Sha256): Buffer {
  const target = join(paths.vault, reference.slice('sha256:'.length));
  const { bytes } = observeFile(target);
  if (bytes === null || sha256Prefixed(bytes) !== reference) throw invalidState(`the vault entry is missing or does not match its name: ${target}`);
  return bytes;
}
