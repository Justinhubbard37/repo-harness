import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import { HostConfigError, type PathCommitted } from '../../core/host-config/types';
import { retryWindowsSharingRace } from '../atomic-append';
import { hashManagedTree } from '../managed-tree';

/** The whole entry that a path write puts at a path: a file, a link, or a copy of a directory tree. */
export type PathEntry =
  | { readonly type: 'file'; readonly bytes: Buffer; readonly mode?: number }
  | { readonly type: 'symlink'; readonly target: string }
  | { readonly type: 'directory'; readonly source: string };

/** The entry at a path as a record would commit it; null when nothing is there. A special file is not a whole-path entry. */
export function observePathEntry(path: string): PathCommitted | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { type: 'symlink', target: readlinkSync(path) };
  if (stat.isFile()) return { type: 'file', sha256: sha256Prefixed(readFileSync(path)) };
  if (stat.isDirectory()) return { type: 'directory', sha256: hashManagedTree(path) };
  throw new HostConfigError('host_config_invalid_state', `not a file, link or directory: ${path}`);
}

export function sameCommitted(left: PathCommitted | null, right: PathCommitted | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Write the entry beside the path; the caller records it and then publishes it. */
export function stagePathEntry(path: string, entry: PathEntry): { readonly staged: string; readonly committed: PathCommitted } {
  const staged = `${path}.${randomUUID()}.rh-stage`;
  try {
    if (entry.type === 'file') {
      writeFileSync(staged, entry.bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(staged, (entry.mode ?? 0o644) & 0o777);
    } else if (entry.type === 'symlink') symlinkSync(entry.target, staged);
    else cpSync(entry.source, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    return { staged, committed: observePathEntry(staged)! };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Put the staged entry at the path. A file or link replaces the old entry by
 * one rename; a directory cannot, so the old tree moves aside first and goes
 * after the new one is in place.
 */
export function publishPathEntry(staged: string, path: string): void {
  const old = lstatSync(path, { throwIfNoEntry: false });
  if (!old?.isDirectory() || old.isSymbolicLink()) {
    retryWindowsSharingRace(() => renameSync(staged, path));
    return;
  }
  const aside = `${path}.${randomUUID()}.rh-old`;
  retryWindowsSharingRace(() => renameSync(path, aside));
  try { retryWindowsSharingRace(() => renameSync(staged, path)); }
  catch (error) { renameSync(aside, path); throw error; }
  rmSync(aside, { recursive: true, force: true });
}

export function discardStagedEntry(staged: string): void {
  rmSync(staged, { recursive: true, force: true });
}

/** Remove a whole entry; a tree moves aside first, so a failure never leaves half a tree. */
export function removePathEntry(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) { retryWindowsSharingRace(() => rmSync(path, { force: true })); return; }
  const aside = `${path}.${randomUUID()}.rh-old`;
  retryWindowsSharingRace(() => renameSync(path, aside));
  rmSync(aside, { recursive: true, force: true });
}

/** Where a transaction keeps the entry that rh wrote at a path before this transaction replaced or removed it. */
export function preimagePath(transaction: string, key: string): string {
  return join(transaction, 'host-config-paths', sha256Hex(Buffer.from(key, 'utf8')));
}

/** Keep the first entry of the transaction at the path: a later write in the same transaction does not replace it. */
export function keepPreimage(transaction: string, key: string): void {
  const target = preimagePath(transaction, key);
  if (lstatSync(target, { throwIfNoEntry: false }) || lstatSync(target + '.absent', { throwIfNoEntry: false })) return;
  if (!lstatSync(key, { throwIfNoEntry: false })) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target + '.absent', '', { flag: 'wx', mode: 0o600 });
    return;
  }
  cpSync(key, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

/** True when the transaction holds an entry for the path. */
export function hasPreimage(transaction: string, key: string): boolean {
  const path = preimagePath(transaction, key);
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined || lstatSync(path + '.absent', { throwIfNoEntry: false }) !== undefined;
}

/** Put the transaction's entry back at the path, in place of what is there. */
export function restorePreimage(transaction: string, key: string): void {
  const source = preimagePath(transaction, key);
  if (lstatSync(source + '.absent', { throwIfNoEntry: false })) { removePathEntry(key); return; }
  const staged = `${key}.${randomUUID()}.rh-stage`;
  cpSync(source, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (lstatSync(key, { throwIfNoEntry: false })) publishPathEntry(staged, key);
  else retryWindowsSharingRace(() => renameSync(staged, key));
}
