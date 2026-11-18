import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { CODEX_CONFIG_FRAGMENTS, codexConfigFragment, isCodexConfigSelector, namingTomlFile, tomlFragment, type CodexConfigSelector } from '../../core/host-config/toml-fragment';
import { HostConfigError, type FragmentRecord } from '../../core/host-config/types';
import { openHostConfigGate, type HostConfigAdoption, type HostConfigRevertEntry } from '../../effects/host-config/gate';
import { configurationReceiptPath, hostConfigurationRoot, readRawConfigurationReceipt, saveConfigurationReceipt, type ConfigurationReceipt } from './configuration-ownership';
import { CODEGRAPH_CONFIG_MARKER } from './install-profile';
import { readLegacyManifest, type LegacyManifestSurface } from './install-state';

/**
 * One-shot migration of `~/.codex/config.toml` into the host-config ledger.
 * Earlier rh versions recorded its fragments in `configuration-restore.json`
 * and the CodeGraph table in the install-state ownership manifest. Each such
 * record becomes a fragment record of one adopted file; the file's backup is
 * the current file with every intact rh fragment set back to its old text, the
 * state that the old receipt uninstall restored. Then the old records go.
 */
export interface CodexConfigMigration {
  readonly path: string;
  /** Null when no old record is still active: only the old records go. */
  readonly adoption: HostConfigAdoption | null;
  readonly receipt: ConfigurationReceipt | null;
}

interface OldFragment {
  readonly selector: CodexConfigSelector;
  readonly before: string | null;
  readonly installed: string | null;
}

function invalid(message: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', message);
}

function isFragmentText(value: unknown, selector: CodexConfigSelector): value is string | null {
  if (value === null) return true;
  // Recorded text that does not parse is an invalid receipt entry, not an error of config.toml.
  try { return typeof value === 'string' && codexConfigFragment(value, selector) === value; } catch (error) {
    if (error instanceof SyntaxError || error instanceof HostConfigError) return false;
    throw error;
  }
}

/** The receipt's entries of the Codex file as written, and the receipt without them for the JSON reader to validate. */
export function splitCodexReceiptEntries(raw: any, path: string): { entries: any[]; rest: any } {
  if (raw === null || !Array.isArray(raw?.changes)) return { entries: [], rest: raw };
  const entries = raw.changes.filter((entry: any) => entry?.path === path);
  return { entries, rest: entries.length ? { ...raw, changes: raw.changes.filter((entry: any) => !entries.includes(entry)) } : raw };
}

/** The receipt's TOML entries; every other entry stays for the JSON reader to validate. */
function receiptFragments(raw: any, path: string, receiptPath: string): { fragments: OldFragment[]; rest: ConfigurationReceipt | null } {
  if (raw === null || !Array.isArray(raw?.changes)) return { fragments: [], rest: null };
  const pending = Array.isArray(raw.pending?.before) ? raw.pending.before.filter((entry: any) => entry?.path === path) : [];
  if (pending.length) {
    const selectors = pending.map((entry: any) => String(entry.selector)).join(', ');
    throw invalid(`interrupted Codex configuration change (${selectors}) in ${path}. Restore each fragment in that file from its value in the "pending" block of ${receiptPath}, then remove those entries from the block`);
  }
  const { entries, rest } = splitCodexReceiptEntries(raw, path);
  if (!entries.length) return { fragments: [], rest: null };
  const fragments: OldFragment[] = [];
  for (const entry of entries) {
    if (!isCodexConfigSelector(entry.selector) || typeof entry.active !== 'boolean'
      || !isFragmentText(entry.before, entry.selector) || !isFragmentText(entry.installed, entry.selector)) throw invalid(`invalid Codex configuration receipt entry: ${receiptPath}`);
    if (entry.active) fragments.push({ selector: entry.selector, before: entry.before, installed: entry.installed });
  }
  return { fragments, rest };
}

function isTomlProjection(path: string) {
  return (surface: LegacyManifestSurface) => surface.path === path && surface.managed_marker === CODEGRAPH_CONFIG_MARKER;
}

/** The hash that the old manifest recorded: the table's lines with LF ends, trimmed. */
function projectionHash(fragment: string): string {
  return sha256Prefixed(fragment.split(/\r?\n/).join('\n').trim());
}

/**
 * The protocol 3 manifest's CodeGraph tables of this file, as receipt-shaped
 * fragments with no text before rh. The state migration that runs next drops
 * the manifest; it converts no section record.
 */
function manifestFragments(manifest: ReturnType<typeof readLegacyManifest>, path: string, content: string): { fragments: OldFragment[]; changed: boolean; present: boolean } {
  const surfaces = manifest?.current.filter(isTomlProjection(path)) ?? [];
  const previous = manifest?.previous.filter(isTomlProjection(path)) ?? [];
  if (!surfaces.length && !previous.length) return { fragments: [], changed: false, present: false };
  const current = codexConfigFragment(content, 'mcp_servers.codegraph');
  const intact = current !== null && surfaces.some((surface) => surface.content_hash === projectionHash(current));
  return {
    // The trimmed manifest hash proves the table, but not its leading line break.
    fragments: intact ? [{ selector: 'mcp_servers.codegraph', before: null, installed: current.replace(/^\r?\n/, '') }] : [],
    // A recorded table that the user changed keeps the file out of a revert, as the old uninstall preserved it.
    changed: surfaces.length > 0 && current !== null && !intact,
    present: true,
  };
}

function setFragment(content: string, selector: CodexConfigSelector, text: string | null): string {
  const edit = tomlFragment.apply(content, selector, text ?? '');
  return content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
}

function adoption(content: string, fragments: readonly OldFragment[], manifestChanged: boolean): HostConfigAdoption | null {
  if (!fragments.length && !manifestChanged) return null;
  let backup = content;
  let externalChange = manifestChanged;
  const adopted: Omit<FragmentRecord, 'file'>[] = [];
  for (const fragment of fragments) {
    const current = codexConfigFragment(content, fragment.selector);
    let inserted = fragment.installed ?? '';
    let separator: FragmentRecord['separator'];
    if (current === fragment.installed) backup = setFragment(backup, fragment.selector, fragment.before);
    else if (inserted !== '' && (current === `\n${inserted}` || current === `\r\n${inserted}`) && backup.endsWith(inserted)) {
      // The receipt proves the table bytes, but not the preceding line break.
      // Record the full span for the gate's intact check and keep the break on removal.
      backup = backup.slice(0, -inserted.length) + (fragment.before ?? '');
      separator = current.startsWith('\r\n') ? '\r\n' : '\n';
      inserted = current;
    } else externalChange = true;
    adopted.push({ owner: CODEX_CONFIG_FRAGMENTS[fragment.selector], selector: fragment.selector, kind: fragment.before === null ? 'add' : 'override', inserted, ...(separator !== undefined ? { separator } : {}) });
  }
  // A whitespace-only backup still holds user bytes when the separator is unproven.
  const keepBackup = backup.trim() !== '' || adopted.some((fragment) => fragment.separator !== undefined);
  return { backup: keepBackup ? Buffer.from(backup, 'utf8') : null, fragments: adopted, externalChange };
}

/** Plan the migration without writing; null when no old record names the file. */
export function planCodexConfigMigration(env: NodeJS.ProcessEnv): CodexConfigMigration | null {
  const home = hostConfigurationRoot(env);
  const path = join(home, '.codex', 'config.toml');
  const receipt = receiptFragments(readRawConfigurationReceipt(home), path, configurationReceiptPath(home));
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // The file's own spelling errors name the file.
  try {
    const manifest = manifestFragments(readLegacyManifest(env), path, content);
    if (!receipt.rest && !manifest.present) return null;
    // A receipt entry for the CodeGraph table is the older and more exact record of it.
    const fromManifest = manifest.fragments.filter((fragment) => !receipt.fragments.some((entry) => entry.selector === fragment.selector));
    return { path, adoption: adoption(content, [...receipt.fragments, ...fromManifest], manifest.changed), receipt: receipt.rest };
  } catch (error) {
    if (!(error instanceof HostConfigError)) throw namingTomlFile(path, error);
    throw new HostConfigError(error.code, `${path}: ${error.message}`, { cause: error });
  }
}

/** Run the migration once: the ledger records come first, then the old records go. A later run finds none. */
export function migrateCodexConfigRecords(env: NodeJS.ProcessEnv): void {
  const migration = planCodexConfigMigration(env);
  if (!migration) return;
  if (migration.adoption) openHostConfigGate({ env }).adopt(migration.path, migration.adoption);
  const home = hostConfigurationRoot(env);
  if (migration.receipt) saveConfigurationReceipt(migration.receipt, home);
}

/** What a revert of the adopted file would report, for a dry run before the migration. */
export function previewAdoptedRevert(migration: CodexConfigMigration): HostConfigRevertEntry[] {
  const { path, adoption: adopted } = migration;
  if (!adopted) return [];
  if (adopted.externalChange) return [{ path, action: 'kept_edited' }];
  if (adopted.backup === null) return [{ path, action: 'removed' }];
  const current = existsSync(path) ? readFileSync(path) : null;
  return [{ path, action: current !== null && adopted.backup.equals(current) ? 'released' : 'text_removed' }];
}
