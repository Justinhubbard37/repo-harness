import { existsSync, readFileSync, rmSync } from 'node:fs';
import { requireHome } from '../../effects/repo-harness-home';
import { join } from 'node:path';
import { isRecord } from '../../core/evidence/is-record';
import type { PathRecord } from '../../core/host-config/types';
import { hostConfigPaths, migrateLedgerSchema, projectedLedgerPaths } from '../../effects/host-config/store';
import { partitionPathRecords, pathRecordHost, pathRecordIsCurrent, pathRecordKey, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import { migrateCodexConfigRecords } from './codex-config-migration';
import { agentFleetTargetPaths, isLegacyOwnershipSurface, writeState, type InstallState } from './install-profile';
import { enabledPlugins, installProfileStatePath, InstallStateError, invalidOwnership, parseProtocol3InstallState, readRawInstallState, type Protocol3Snapshot } from './install-state';
import { migrateJsonConfigRecords } from './json-config-migration';

/**
 * The one-shot move of host path ownership from the protocol 3
 * `ownership_manifest` and `agent-fleet-user-managed.json` to the host-config
 * ledger's path records. It runs at the lock-holding entry points before any
 * other state read; every other reader fails closed on protocol 3.
 */

const FLEET_RECEIPT = 'agent-fleet-user-managed.json';

function fleetReceiptPath(env: NodeJS.ProcessEnv): string {
  return join(requireHome(env), '.repo-harness', FLEET_RECEIPT);
}

/** True when the state still is protocol 3, so the next entry point migrates it. */
export function installStatePendingMigration(env: NodeJS.ProcessEnv): boolean {
  return parseProtocol3InstallState(readRawInstallState(env), installProfileStatePath(env)) !== null;
}

/** The fleet files that the user keeps, by path; null without a receipt. A malformed receipt stops: rh must not overwrite those files. */
function readFleetReceipt(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> | null {
  const path = fleetReceiptPath(env);
  if (!existsSync(path)) return null;
  const allowed = new Set(agentFleetTargetPaths(env));
  const malformed = () => new InstallStateError('install_state_invalid', path, `the agent fleet receipt is malformed; fix or remove it, then run rh update: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); } catch { throw malformed(); }
  if (!isRecord(parsed) || parsed.protocol !== 1 || parsed.authority !== 'user-managed-agent-fleet' || !Array.isArray(parsed.files)) throw malformed();
  const hashes = new Map<string, string>();
  for (const entry of parsed.files) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !allowed.has(entry.path) || typeof entry.sha256 !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256) || hashes.has(entry.path)) throw malformed();
    hashes.set(entry.path, entry.sha256);
  }
  return hashes;
}

/** One manifest surface as a path record, or as a Pi package source; null for a section record or a marker that never proved currency. */
function convertSurface(env: NodeJS.ProcessEnv, surface: Record<string, unknown>, statePath: string):
  { readonly key: string; readonly record: PathRecord } | { readonly pi: string } | null {
  const path = surface.path as string;
  if (surface.type === 'pi-package') return { pi: path };
  const marker = surface.managed_marker;
  let committed: PathRecord['committed'];
  if (surface.type === 'symlink') committed = { type: 'symlink', target: surface.symlink_target as string };
  else if (surface.type === 'managed-file') {
    // The #2847 and #2848 migrations own the section records of the host files; no other marker made a file current.
    if (marker !== 'transaction-created-file') return null;
    committed = { type: 'file', sha256: surface.content_hash as string };
  } else if (marker === 'herdr-skill-marker') committed = { type: 'directory', proof: 'herdr-skill-marker' };
  else committed = { type: 'directory', sha256: surface.content_hash as string };
  const host = pathRecordHost(env, path);
  if (host === null) throw invalidOwnership(statePath);
  return { key: pathRecordKey(env, path), record: { owner: surface.owner as string, host, kind: 'created', baseline: { state: 'unknown' }, committed } };
}

function checkedManifest(env: NodeJS.ProcessEnv, snapshot: Protocol3Snapshot, statePath: string): Record<string, unknown>[] {
  const plugins = enabledPlugins(snapshot.fields);
  if (!snapshot.manifest.every((surface) => isLegacyOwnershipSurface(surface, env, plugins))) throw invalidOwnership(statePath);
  return snapshot.manifest as Record<string, unknown>[];
}

function piSources(env: NodeJS.ProcessEnv, snapshot: Protocol3Snapshot, statePath: string): string[] {
  return checkedManifest(env, snapshot, statePath).filter((surface) => surface.type === 'pi-package').map((surface) => surface.path as string);
}

/**
 * Run the move once. While the state is protocol 3 its manifest is the only
 * authority for `created` records, so they are replaced, not merged: a released
 * parent's rollback restores the state but not the ledger, and the next run
 * then rebuilds the records from the restored manifest. `user_managed` records
 * stay. Order: ledger, receipt removal, protocol 4 state; a stop between them
 * leaves a state that the next run migrates again.
 */
export function migrateInstallState(env: NodeJS.ProcessEnv): void {
  // The ledger gains its `paths` map before any gate or path-record write reads it.
  migrateLedgerSchema(hostConfigPaths(env));
  if (installStatePendingMigration(env)) {
    // The section records of the host files leave with the manifest, so their migrations read it first.
    migrateCodexConfigRecords(env);
    migrateJsonConfigRecords(env);
  }
  const plan = planInstallStateMigration(env);
  if (plan === null) return;
  writePathRecords(env, plan.records);
  if (plan.receipt) rmSync(fleetReceiptPath(env), { force: true });
  if (plan.state) writeState(plan.state, env);
}

/** What the move writes: the path records, whether the receipt goes, and the protocol 4 state; null when nothing moves. It writes nothing, so a dry run uses it too. */
export interface InstallStateMigrationPlan {
  readonly records: PathRecords;
  readonly receipt: boolean;
  readonly state: InstallState | null;
}

export function planInstallStateMigration(env: NodeJS.ProcessEnv): InstallStateMigrationPlan | null {
  const statePath = installProfileStatePath(env);
  const legacy = parseProtocol3InstallState(readRawInstallState(env), statePath);
  const receipt = readFleetReceipt(env);
  if (legacy === null && receipt === null) return null;
  const records: Record<string, PathRecord> = Object.fromEntries(Object.entries(partitionPathRecords(env, projectedLedgerPaths(hostConfigPaths(env))).records)
    .filter(([, record]) => legacy === null || record.kind === 'user_managed'));
  const pi: string[] = [];
  if (legacy) {
    for (const surface of checkedManifest(env, legacy.current, statePath)) {
      const converted = convertSurface(env, surface, statePath);
      if (converted === null) continue;
      if ('pi' in converted) { pi.push(converted.pi); continue; }
      const existing = records[converted.key];
      if (existing && (existing.kind === 'user_managed' || pathRecordIsCurrent(converted.key, existing))) continue;
      records[converted.key] = converted.record;
    }
  }
  for (const [path, sha256] of receipt ?? []) {
    const host = pathRecordHost(env, path);
    if (host === null) throw invalidOwnership(statePath);
    records[pathRecordKey(env, path)] = { owner: 'core', host, kind: 'user_managed', baseline: { state: 'unknown' }, committed: { type: 'file', sha256 } };
  }
  const previous = legacy?.previous ?? null;
  return {
    records,
    receipt: receipt !== null,
    state: legacy && {
      ...legacy.current.fields,
      pi_packages: [...new Set(pi)],
      previous: previous && { ...previous.fields, pi_packages: [...new Set(piSources(env, previous, statePath))] },
    },
  };
}
