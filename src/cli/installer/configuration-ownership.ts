import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { retryWindowsSharingRace } from '../../effects/atomic-append';
import { requireHome } from '../../effects/repo-harness-home';
import { dirname, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';

/** The receipt of earlier rh versions; only the one-shot migrations into the host-config ledger read it. */
export interface ConfigurationReceipt {
  protocol: 1;
  changes: { path: string; selector: string; before: string | null; installed: string | null; active: boolean }[];
  pending?: { id: string; before: Array<{ path: string; selector: string; value: string | null }> };
}
/**
 * The scope root owns the configuration files and their receipt: the account
 * home for host installs, or one repository root for project setup.
 */
export const hostConfigurationRoot = (env: NodeJS.ProcessEnv = process.env): string => requireHome(env);

export const configurationReceiptPath = (root: string): string =>
  join(root, '.repo-harness', 'configuration-restore.json');

export function assertConfigurationPath(path: string, root: string): void {
  const base = resolve(root);
  const rel = relative(base, resolve(path));
  if (!rel) return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) !== path) throw new Error(`unsafe configuration path: ${path}`);
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink configuration path: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function writePrivateConfiguration(path: string, content: string, root: string): void {
  assertConfigurationPath(path, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    retryWindowsSharingRace(() => renameSync(temp, path));
    chmodSync(path, 0o600);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

/** The receipt file as JSON, unvalidated; null when it does not exist. */
export function readRawConfigurationReceipt(root: string): unknown {
  const path = configurationReceiptPath(root);
  assertConfigurationPath(path, root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The migrations write back what is left of the receipt; the file goes with its last entry. */
export function saveConfigurationReceipt(receipt: ConfigurationReceipt, root: string): void {
  const path = configurationReceiptPath(root);
  if (receipt.changes.length || receipt.pending) writePrivateConfiguration(path, `${JSON.stringify(receipt, null, 2)}\n`, root);
  else { assertConfigurationPath(path, root); if (existsSync(path)) unlinkSync(path); }
}
