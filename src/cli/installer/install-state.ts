import { existsSync, readFileSync } from 'fs';
import { requireHome } from '../../effects/repo-harness-home';
import { join } from 'path';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { isRecord } from '../../core/evidence/is-record';
import { isPluginId, PLUGIN_IDS, type PluginId, type PluginSelection } from '../../core/skill-surface/plugin-manifest';

/**
 * The install-state read model: the state path, the protocol, the plugins and
 * the selection. It has no package-asset and no host-path dependency, so a
 * hook process can read the recorded selection. The installer
 * (install-profile.ts) builds on this parser. Host path ownership lives in
 * the host-config ledger's path records, not here.
 */

export const INSTALL_STATE_PROTOCOL = 4 as const;

export interface InstalledPlugin {
  readonly id: PluginId;
  readonly version: string;
}

export interface RecordedInstallState {
  readonly protocol: typeof INSTALL_STATE_PROTOCOL;
  /** Core records only its version. The package manifest owns the plugin-to-surface map. */
  readonly core: { readonly version: string };
  /** Enabled plugins only: sorted, unique. Absence means disabled. */
  readonly plugins: readonly InstalledPlugin[];
  /** How the plugin set was chosen. An explicit list equals the plugin ids; `all` holds any subset. */
  readonly selection: PluginSelection;
  readonly transaction_id: string;
  readonly applied_at: string;
  /** The Pi package sources that an install registered and may remove; the ledger has no Pi record yet (#2852). */
  readonly pi_packages: readonly string[];
  readonly previous: RecordedInstallSnapshot | null;
}

export type RecordedInstallSnapshot = Omit<RecordedInstallState, 'previous'>;

export type InstallStateErrorCode =
  | 'install_state_missing'
  | 'install_state_protocol_retired'
  | 'install_state_invalid'
  | 'install_state_invalid_ownership'
  | 'install_plugin_unavailable';

/** Typed failure of the install state or of a requested selection. Nothing is written before it is thrown. */
export class InstallStateError extends Error {
  constructor(readonly code: InstallStateErrorCode, readonly path: string, message: string) {
    super(message);
    this.name = 'InstallStateError';
  }
}

export function installProfileStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(requireHome(env), '.repo-harness', 'install-state.json');
}

export function enabledPlugins(state: Pick<RecordedInstallState, 'plugins'>): readonly PluginId[] {
  return state.plugins.map(plugin => plugin.id);
}

function invalidInstallState(path: string, detail: string): InstallStateError {
  return new InstallStateError('install_state_invalid', path, `install state ${detail}; inspect: rh install --state: ${path}`);
}

/** The installer throws the same error for a Pi package that fails its source check. */
export function invalidOwnership(path: string): InstallStateError {
  return new InstallStateError('install_state_invalid_ownership', path,
    `install state has an invalid Pi package (not the Bun global package root, or the pi plugin is not enabled); inspect: rh install --state: ${path}`);
}

function parsePlugins(raw: unknown, coreVersion: string, path: string): readonly InstalledPlugin[] {
  if (!Array.isArray(raw)) throw invalidInstallState(path, 'has no plugins array');
  const plugins = raw.map((entry): InstalledPlugin => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'id,version') throw invalidInstallState(path, 'has a malformed plugin entry');
    if (!isPluginId(entry.id)) {
      throw new InstallStateError('install_state_invalid', path, `install state names unknown plugin ${JSON.stringify(entry.id)}; expected one of ${PLUGIN_IDS.join(', ')}: ${path}`);
    }
    // Plugin versions equal the core version until plugins ship separately (#1287 step 4).
    if (entry.version !== coreVersion) throw invalidInstallState(path, `records plugin ${entry.id} at version ${String(entry.version)}, not ${coreVersion}`);
    return { id: entry.id, version: entry.version };
  });
  const ids = plugins.map(plugin => plugin.id);
  if (ids.join(',') !== PLUGIN_IDS.filter(id => ids.includes(id)).join(',')) throw invalidInstallState(path, 'plugins are not sorted and unique');
  return plugins;
}

/** `all`, or the explicit list, which must equal the recorded plugin ids. Nothing is inferred from the plugin entries. */
function parseSelection(raw: unknown, ids: readonly PluginId[], path: string, label: string): PluginSelection {
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw) || !raw.every(isPluginId)) throw invalidInstallState(path, `${label} has no valid selection ("all" or a list of plugin ids)`);
  if (raw.join(',') !== ids.join(',')) {
    throw invalidInstallState(path, `${label} selection ${JSON.stringify(raw)} does not equal its plugins ${JSON.stringify(ids)}`);
  }
  return ids;
}

/** 0.25.4 is the last release that reads protocol 2: its `update` migrates the state to protocol 3 (#1607). */
const PROTOCOL_2_BRIDGE = 'bun add -g repo-harness@0.25.4 --no-cache && repo-harness update --version 0.25.4';
const CURRENT_PACKAGE_UPDATE = `bun add -g repo-harness@${PACKAGE_VERSION} --no-cache && rh update`;

function parseSnapshot(raw: unknown, path: string, label: string): RecordedInstallSnapshot {
  const { fields, extra } = parseSnapshotFields(raw, path, label, INSTALL_STATE_PROTOCOL);
  if (!Array.isArray(extra.pi_packages) || !extra.pi_packages.every((source) => typeof source === 'string')
    || new Set(extra.pi_packages).size !== extra.pi_packages.length) throw invalidOwnership(path);
  return { ...fields, pi_packages: extra.pi_packages };
}

/** The fields that protocols 3 and 4 share; `extra` is the raw object for the fields that differ. */
function parseSnapshotFields(raw: unknown, path: string, label: string, protocol: 3 | typeof INSTALL_STATE_PROTOCOL):
  { readonly fields: Omit<RecordedInstallSnapshot, 'pi_packages'>; readonly extra: Record<string, unknown> } {
  if (!isRecord(raw)) throw invalidInstallState(path, `${label} is not an object`);
  if (raw.protocol === 1) {
    throw new InstallStateError('install_state_protocol_retired', path,
      `install state ${path} is protocol 1, which this package no longer reads. Migrate it with the 0.25.x bridge first: `
      + 'bun add -g repo-harness@0.25.3 --no-cache, then run its protocol 1 migration (repo-harness install --help in 0.25.3 names it); '
      + `then the protocol 2 bridge: ${PROTOCOL_2_BRIDGE}; then: ${CURRENT_PACKAGE_UPDATE}`);
  }
  if (raw.protocol === 2) {
    throw new InstallStateError('install_state_protocol_retired', path,
      `install state ${path} is protocol 2, which this package no longer reads. Migrate it with the 0.25.4 bridge first: `
      + `${PROTOCOL_2_BRIDGE} (its update migrates protocol 2 to 3); then: ${CURRENT_PACKAGE_UPDATE}`);
  }
  if (raw.protocol === 3 && protocol !== 3) {
    throw new InstallStateError('install_state_protocol_retired', path,
      `install state ${path} is protocol 3, which keeps host path ownership in the retired ownership_manifest. Run: rh update `
      + '(its install step moves the ownership records to the host-config ledger and writes protocol 4)');
  }
  if (raw.protocol !== protocol) throw invalidInstallState(path, `${label} has unsupported protocol ${String(raw.protocol)}`);
  if (!isRecord(raw.core) || Object.keys(raw.core).join(',') !== 'version' || typeof raw.core.version !== 'string' || !raw.core.version.trim()) {
    throw invalidInstallState(path, `${label} has an invalid core version`);
  }
  const plugins = parsePlugins(raw.plugins, raw.core.version, path);
  const selection = parseSelection(raw.selection, plugins.map(plugin => plugin.id), path, label);
  if (typeof raw.transaction_id !== 'string' || typeof raw.applied_at !== 'string') throw invalidInstallState(path, `${label} has invalid metadata`);
  return {
    fields: {
      protocol: INSTALL_STATE_PROTOCOL,
      core: { version: raw.core.version },
      plugins,
      selection,
      transaction_id: raw.transaction_id,
      applied_at: raw.applied_at,
    },
    extra: raw,
  };
}

function previousOf(raw: unknown, path: string): Record<string, unknown> | null {
  const previousRaw = isRecord(raw) ? raw.previous : undefined;
  if (previousRaw === null) return null;
  if (!isRecord(previousRaw) || 'previous' in previousRaw) throw invalidInstallState(path, 'has an invalid previous state');
  return previousRaw;
}

/** The strict protocol 4 reader. Protocols 1, 2 and 3 fail closed with `install_state_protocol_retired`. */
export function parseRecordedInstallState(raw: unknown, path: string): RecordedInstallState {
  const current = parseSnapshot(raw, path, 'state');
  const previous = previousOf(raw, path);
  return { ...current, previous: previous === null ? null : parseSnapshot(previous, path, 'previous state') };
}

/** A protocol 3 snapshot as the one-shot migration reads it: the shared fields, and its manifest unchecked. */
export interface Protocol3Snapshot {
  readonly fields: Omit<RecordedInstallSnapshot, 'pi_packages'>;
  readonly manifest: readonly unknown[];
}

/** The protocol 3 reader of the one-shot migration (install-state-migration.ts); null for any other protocol. */
export function parseProtocol3InstallState(raw: unknown, path: string): { readonly current: Protocol3Snapshot; readonly previous: Protocol3Snapshot | null } | null {
  if (!isRecord(raw) || raw.protocol !== 3) return null;
  const snapshot = (value: unknown, label: string): Protocol3Snapshot => {
    const { fields, extra } = parseSnapshotFields(value, path, label, 3);
    if (!Array.isArray(extra.ownership_manifest)) throw invalidInstallState(path, `${label} has no ownership_manifest array`);
    return { fields, manifest: extra.ownership_manifest };
  };
  const previous = previousOf(raw, path);
  return { current: snapshot(raw, 'state'), previous: previous === null ? null : snapshot(previous, 'previous state') };
}

/** The raw JSON of the state file, or undefined when it is absent. */
export function readRawInstallState(env: NodeJS.ProcessEnv = process.env): unknown {
  const path = installProfileStatePath(env);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw invalidInstallState(path, `is not valid JSON (${(error as Error).message})`);
  }
}

/** The recorded state at the HOME of `env`, or null when the file is absent. */
export function readRecordedInstallState(env: NodeJS.ProcessEnv = process.env): RecordedInstallState | null {
  const raw = readRawInstallState(env);
  return raw === undefined ? null : parseRecordedInstallState(raw, installProfileStatePath(env));
}

/** The fields of a protocol 3 manifest surface that the host-file migrations (#2847, #2848) read. */
export interface LegacyManifestSurface {
  readonly path: string;
  readonly managed_marker: string | null;
  readonly content_hash: string | null;
}

function legacySurfaces(manifest: readonly unknown[]): LegacyManifestSurface[] {
  return manifest.flatMap((raw) => isRecord(raw) && typeof raw.path === 'string'
    ? [{ path: raw.path, managed_marker: typeof raw.managed_marker === 'string' ? raw.managed_marker : null, content_hash: typeof raw.content_hash === 'string' ? raw.content_hash : null }]
    : []);
}

/** The manifest of a protocol 3 state, for the host-file migrations that run before the state migration; null for protocol 4 or no state. */
export function readLegacyManifest(env: NodeJS.ProcessEnv = process.env): { readonly current: readonly LegacyManifestSurface[]; readonly previous: readonly LegacyManifestSurface[] } | null {
  const legacy = parseProtocol3InstallState(readRawInstallState(env), installProfileStatePath(env));
  return legacy && { current: legacySurfaces(legacy.current.manifest), previous: legacySurfaces(legacy.previous?.manifest ?? []) };
}
