import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { retryWindowsSharingRace } from '../../effects/atomic-append';
import { homedir } from 'os';
import { dirname, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';

export interface ConfigurationRestore {
  path: string;
  selector: string;
  before: string | null;
  installed: string | null;
  active: boolean;
}
export interface ConfigurationReceipt {
  protocol: 1;
  changes: ConfigurationRestore[];
  pending?: { id: string; before: Array<{ path: string; selector: string; value: string | null }> };
}
/**
 * The scope root owns the configuration files and their receipt: the account
 * home for host installs, or one repository root for project setup.
 */
export const hostConfigurationRoot = (env: NodeJS.ProcessEnv = process.env): string => env.HOME ?? homedir();

export const configurationReceiptPath = (root: string): string =>
  join(root, '.repo-harness', 'configuration-restore.json');

/** Only these shared configuration fragments can be restored by an install receipt. `~/.codex/config.toml` is in the host-config ledger. */
export function configurationPaths(root: string): string[] {
  return [join(root, '.claude.json'), join(root, '.claude/settings.json')];
}

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

function jsonObject(raw: string): Record<string, any> {
  const value = JSON.parse(raw || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration must be a JSON object');
  return value;
}

const RECORDED_SELECTORS = ['mcpServers.codegraph', 'allowedTools.codegraph'];

/** Accept only the CodeGraph configuration selectors. */
function validSelector(selector: string): boolean {
  return RECORDED_SELECTORS.includes(selector);
}

export function readConfigurationFragment(path: string, raw: string, selector: string): string | null {
  if (!validSelector(selector)) throw new Error(`invalid configuration selector: ${selector}`);
  const value = jsonObject(raw);
  if (selector === 'mcpServers.codegraph') return value.mcpServers?.codegraph === undefined ? null : JSON.stringify(value.mcpServers.codegraph);
  if (value.allowedTools !== undefined && !Array.isArray(value.allowedTools)) throw new Error('allowedTools must be an array');
  return value.allowedTools?.includes('mcp__codegraph__*') ? JSON.stringify('mcp__codegraph__*') : null;
}

export function replaceConfigurationFragment(path: string, raw: string, selector: string, value: string | null): string {
  if (!validSelector(selector)) throw new Error(`invalid configuration selector: ${selector}`);
  const parsed = jsonObject(raw);
  if (selector === 'mcpServers.codegraph') {
    if (value === null) { if (parsed.mcpServers) { delete parsed.mcpServers.codegraph; if (!Object.keys(parsed.mcpServers).length) delete parsed.mcpServers; } }
    else { parsed.mcpServers ??= {}; parsed.mcpServers.codegraph = JSON.parse(value); }
  } else {
    const entries = parsed.allowedTools ?? [];
    if (!Array.isArray(entries)) throw new Error('allowedTools must be an array');
    parsed.allowedTools = entries.filter((entry: unknown) => entry !== 'mcp__codegraph__*');
    if (value !== null) parsed.allowedTools.push(JSON.parse(value));
    if (!parsed.allowedTools.length) delete parsed.allowedTools;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** The receipt file as JSON, unvalidated; null when it does not exist. */
export function readRawConfigurationReceipt(root: string): unknown {
  const path = configurationReceiptPath(root);
  assertConfigurationPath(path, root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function readConfigurationReceipt(root: string): ConfigurationReceipt {
  return validConfigurationReceipt(readRawConfigurationReceipt(root), root);
}

export function validConfigurationReceipt(raw: any, root: string): ConfigurationReceipt {
  if (raw === null) return { protocol: 1, changes: [] };
  const path = configurationReceiptPath(root);
  const paths = configurationPaths(root);
  const keys = new Set<string>();
  if (raw?.protocol !== 1 || !Array.isArray(raw.changes)) throw new Error(`invalid configuration receipt: ${path}`);
  for (const change of raw.changes) {
    if (!change || !paths.includes(change.path) || typeof change.selector !== 'string' || !validSelector(change.selector)
      || typeof change.active !== 'boolean'
      || !(change.before === null || typeof change.before === 'string') || !(change.installed === null || typeof change.installed === 'string')) throw new Error(`invalid configuration receipt entry: ${path}`);
    const key = `${change.path}\0${change.selector}`;
    if (keys.has(key)) throw new Error(`duplicate configuration receipt entry: ${path}`);
    keys.add(key);
    for (const value of [change.before, change.installed]) if (value !== null) JSON.parse(value);
  }
  if (raw.pending !== undefined) {
    if (!raw.pending || typeof raw.pending.id !== 'string' || !Array.isArray(raw.pending.before)
      || raw.pending.before.some((entry: any) => !entry || !paths.includes(entry.path) || typeof entry.selector !== 'string' || !validSelector(entry.selector) || !(entry.value === null || typeof entry.value === 'string'))) throw new Error(`invalid pending configuration receipt: ${path}`);
    for (const entry of raw.pending.before) if (entry.value !== null) JSON.parse(entry.value);
  }
  return raw;
}

export function saveConfigurationReceipt(receipt: ConfigurationReceipt, root: string): void {
  const path = configurationReceiptPath(root);
  if (receipt.changes.length || receipt.pending) writePrivateConfiguration(path, `${JSON.stringify(receipt, null, 2)}\n`, root);
  else { assertConfigurationPath(path, root); if (existsSync(path)) unlinkSync(path); }
}

export function recordConfigurationChange(path: string, before: string, after: string, root: string, alreadyRecorded = false, pendingId?: string): void {
  if (!configurationPaths(root).includes(path)) return;
  assertConfigurationPath(path, root);
  const receipt = readConfigurationReceipt(root);
  if (receipt.pending && receipt.pending.id !== pendingId) throw new Error(`interrupted configuration transaction; preimage retained at ${configurationReceiptPath(root)}`);
  for (const selector of RECORDED_SELECTORS) {
    const previous = readConfigurationFragment(path, before, selector);
    const installed = readConfigurationFragment(path, after, selector);
    if (previous === installed) continue;
    const existing = receipt.changes.find((entry) => entry.path === path && entry.selector === selector);
    if (existing?.active && existing.installed !== previous && existing.before !== previous && !(alreadyRecorded && existing.installed === installed)) throw new Error(`configuration changed since installation: ${path} ${selector}`);
    if (existing) {
      if (!existing.active) existing.before = previous;
      existing.installed = installed;
      existing.active = true;
    } else receipt.changes.push({ path, selector, before: previous, installed, active: true });
  }
  saveConfigurationReceipt(receipt, root);
}

export function captureConfigurationRestores(transaction: { snapshots: readonly { path: string; existed: boolean; backup_path: string | null }[] }, root: string): void {
  for (const snapshot of transaction.snapshots) {
    if (!configurationPaths(root).includes(snapshot.path)) continue;
    const before = snapshot.existed && snapshot.backup_path ? readFileSync(snapshot.backup_path, 'utf8') : '';
    const after = existsSync(snapshot.path) ? readFileSync(snapshot.path, 'utf8') : '';
    recordConfigurationChange(snapshot.path, before, after, root, true);
  }
}

export function assertRecordedConfigurationCurrent(paths: readonly string[], root: string): void {
  const receipt = readConfigurationReceipt(root);
  if (receipt.pending) throw new Error(`interrupted configuration transaction; preimage retained at ${configurationReceiptPath(root)}`);
  for (const entry of receipt.changes) {
    if (!entry.active || !paths.includes(entry.path)) continue;
    assertConfigurationPath(entry.path, root);
    const raw = existsSync(entry.path) ? readFileSync(entry.path, 'utf8') : '';
    const current = readConfigurationFragment(entry.path, raw, entry.selector);
    if (current !== entry.installed && current !== entry.before) throw new Error(`configuration changed since installation: ${entry.path} ${entry.selector}`);
  }
}

/** Caller holds the runtime transaction lock of the same scope. A killed external writer leaves its preimage durable. */
export function withConfigurationMutation<T>(paths: readonly string[], root: string, mutate: () => T): T {
  assertRecordedConfigurationCurrent(paths, root);
  const receipt = readConfigurationReceipt(root);
  const before = paths.map((path) => {
    if (!configurationPaths(root).includes(path)) throw new Error(`unsupported configuration mutation: ${path}`);
    assertConfigurationPath(path, root);
    return { path, raw: existsSync(path) ? readFileSync(path, 'utf8') : '' };
  });
  const id = randomUUID();
  receipt.pending = { id, before: before.flatMap(({ path, raw }) => RECORDED_SELECTORS
    .map((selector) => ({ path, selector, value: readConfigurationFragment(path, raw, selector) }))) };
  saveConfigurationReceipt(receipt, root);
  const result = mutate();
  for (const snapshot of before) {
    recordConfigurationChange(snapshot.path, snapshot.raw, existsSync(snapshot.path) ? readFileSync(snapshot.path, 'utf8') : '', root, false, id);
  }
  const finalized = readConfigurationReceipt(root);
  if (finalized.pending?.id !== id) throw new Error('configuration transaction ownership changed');
  delete finalized.pending;
  saveConfigurationReceipt(finalized, root);
  return result;
}
