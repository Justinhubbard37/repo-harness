import { globalConfigurationPath, mutateGlobalConfiguration, restoreGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { retryWindowsSharingRace } from '../../effects/atomic-append';
import wazaRules from "../../core/skill-surface/waza-shared-rules.json";
import { bunGlobalPackageRoot, expectedSkillProjections, skillLinkMatches } from './skill-projection';
import { configurationReceiptPath } from './configuration-ownership';
import { ensurePrivateDirectory, hostConfigPaths, putVault, resolveHostPath } from '../../effects/host-config/store';
import { openHostConfigGate, planPathRevert, rollbackHostConfigTransaction } from '../../effects/host-config/gate';
import { migrateCodexConfigRecords } from './codex-config-migration';
import { migrateJsonConfigRecords } from './json-config-migration';
import { pathRecordHost, pathRecordIsCurrent, pathRecordKey, pathRecordsDigest, readPathRecords, readPathRecordSet, registerSupportedPathRecords, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import type { FileBaseline, PathCommitted, PathRecord, PathRecordHost, PathRecordKind } from '../../core/host-config/types';
import { globalContextBackupEligible, globalContextPath } from './global-context';
import { acquireRuntimeTransactionLock, assertRuntimeTransactionContext, globalRuntimeScope, runtimeTransactionLockRelativePath, runtimeTransactionRoot, type RuntimeTransactionContext, type RuntimeTransactionLock, type RuntimeTransactionScope } from '../../effects/locking/runtime-transaction-lock';
import { exclusiveDirectoryLockOwnerLiveness, readExclusiveDirectoryLockOwner } from '../../effects/locking/exclusive-directory-lock';
import { currentProcessStartTime } from '../../effects/locking/process-start-time';
import { randomUUID } from 'crypto';
import { isRecord } from '../../core/evidence/is-record';
import { sha256Prefixed } from '../../core/evidence/sha256';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, delimiter, dirname, join } from 'path';
import {
  compareManagedHookProjection,
  type HookHost,
} from './managed-entries';
import {
  mutationPathSkillNames as catalogMutationPathSkillNames,
  requiredExplicitExternalDependencyInstallGroups,
  validateSkillSurfaceCatalogValue,
  selectionOwnedSkillNames,
  type SkillSurfaceCatalog,
} from '../../core/skill-surface/catalog';
import {
  COMMAND_PLUGINS,
  HOST_PROGRAM_PLUGINS,
  installSelectionCommand,
  UPDATE_COMMAND,
  isCommandPlugin,
  isHostProgramPlugin,
  isSurfaceOwner,
  ownerEnabled,
  PLUGIN_IDS,
  type PluginId,
  type PluginSelection,
  type SurfaceOwner,
} from '../../core/skill-surface/plugin-manifest';
import { hostSkillRoot, providerSkillLock, stagedSkillRoot, syncSkillRoots, type SkillHost } from '../../effects/host-skill-roots';
import { ownedSkillIsIntact } from '../../effects/host-config/herdr-skill-marker';
import { MANAGED_AGENTS } from '../../effects/terminal/task-role-profiles';
import { hashManagedTree, OWNER_MARKER } from '../../effects/managed-tree';
import { readWorkflowPolicyDocument } from '../../effects/state/resolve-effective-state';
import { POLICY_ABSENT, POLICY_PATH, isPolicyObject, policyValue } from '../../core/workflow/policy-schema';
import { capabilitySourceModeOf } from '../../effects/architecture/capability-resolver';
import { piPackagePresent, planPiPackage, removePiPackage, type PiPackageStep } from './pi-package';
import { piExecutable } from '../../effects/pi-executable';
import skillSurfaceManifest from '../../../assets/skill-commands/manifest.json';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { pluginRepair } from './architecture-selection';
import { RETIRED_CLI_NAME } from '../../core/skill-surface/cli-name';
import {
  enabledPlugins,
  INSTALL_STATE_PROTOCOL,
  installProfileStatePath,
  InstallStateError,
  invalidOwnership,
  parseRecordedInstallState,
  readRecordedInstallState,
  type RecordedInstallSnapshot,
  type RecordedInstallState,
} from './install-state';

/**
 * Parses this package's own skill-surface manifest. Not parameterized by
 * env/sourceRoot: install-profile.ts manages installed state at the user's
 * HOME, not a foreign source tree, so its manifest is always the running
 * package's own file. The module system resolves it at build time in a bundle
 * and at load time in source. Fails closed before any caller mutates host
 * state. Deliberately does not pass an `exists` callback for package sources.
 */
export function loadSkillSurfaceCatalog(): SkillSurfaceCatalog {
  const resolution = validateSkillSurfaceCatalogValue(skillSurfaceManifest, { declared: true });
  if (resolution.status !== 'valid') {
    const detail = resolution.diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join('; ');
    throw new Error(`invalid skill-surface catalog assets/skill-commands/manifest.json: ${detail}`);
  }
  return resolution.catalog;
}

export const INSTALL_HOSTS = ['claude', 'codex', 'pi'] as const;
const AGENT_FLEET_FILE = new RegExp(
  `/(?:\\.claude/agents/(?:${MANAGED_AGENTS.join('|')})\\.md|\\.codex/agents/(?:${MANAGED_AGENTS.join('|')})\\.toml)$`,
);

/** The recorded state after the source check of each Pi package. Host path ownership lives in the ledger's path records. */
export type InstallState = RecordedInstallState;

export type InstallStateSnapshot = RecordedInstallSnapshot;

/** One path that an install step wrote, before it becomes a path record. */
interface CapturedPath {
  readonly path: string;
  /** `core`, or the enabled plugin whose selection owns this path. */
  readonly owner: SurfaceOwner;
  readonly committed: PathCommitted;
}

/** One ledger path record as `rh install --state` shows it. */
export interface OwnershipEntry {
  readonly path: string;
  readonly owner: string;
  readonly host: PathRecordHost;
  readonly kind: PathRecordKind;
  readonly type: PathCommitted['type'];
  readonly current: boolean;
}

export interface OwnerProbe {
  readonly status: 'present' | 'missing';
  readonly evidence: readonly string[];
  /** The named checks that found no evidence. */
  readonly missing: readonly string[];
}

export interface InstallStateStatus extends InstallState {
  /** A projection of the ledger's path records. */
  readonly ownership: readonly OwnershipEntry[];
  /** Record keys outside the root of their host: rh does not act on them, and the next record write drops them. */
  readonly ownership_outside_root: readonly string[];
  /** Record keys that name no install surface (path, owner or kind): rh does not act on them, and the next record write drops them. */
  readonly ownership_unsupported: readonly string[];
  /** `core` and each enabled plugin. */
  readonly probes: Readonly<Partial<Record<SurfaceOwner, OwnerProbe>>>;
  readonly drift: {
    readonly status: 'consistent' | 'drift';
    readonly missing_owners: readonly SurfaceOwner[];
    readonly surface_drift: readonly string[];
  };
}

/** A host plugin that the `all` selection does not run or record, because its host program or target is absent. */
export interface SkippedPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The command that adds the plugin after the host program is installed. */
  readonly command: string;
}

/** A recorded host plugin of the `all` selection whose host program or target is now absent. */
export interface KeptPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The explicit selection that removes the plugin. */
  readonly command: string;
}

/**
 * The plugin set of a selection on this host. `run` drives the setup steps;
 * `record` is the set that the install state stores. They differ only by the
 * `kept` plugins, whose ledger surfaces stay untouched.
 */
export interface SelectionResolution {
  readonly run: readonly PluginId[];
  readonly record: readonly PluginId[];
  readonly skipped: readonly SkippedPlugin[];
  readonly kept: readonly KeptPlugin[];
  /** Plugins that a complete refresh would add; a partial refresh never grows the recorded set. */
  readonly notAdded: readonly PluginId[];
}

interface HostSurfaceSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly backup_path: string | null;
}

export interface InstallHostTransaction {
  readonly protocol: 1;
  readonly backup_root: string;
  readonly snapshots: readonly HostSurfaceSnapshot[];
}

/** What ownership capture reads from a transaction: which paths existed before it, and their backups. */
export type HostSurfaceSnapshots = Pick<InstallHostTransaction, 'snapshots'>;

export interface InstallPlan {
  readonly hosts: typeof INSTALL_HOSTS;
  readonly pi_package: PiPackageStep;
  readonly skill_projections: ReturnType<typeof expectedSkillProjections>;
  readonly protocol: typeof INSTALL_STATE_PROTOCOL;
  readonly selection: PluginSelection;
  readonly requested_plugins: readonly PluginId[];
  readonly current_plugins: readonly PluginId[] | null;
  readonly install: readonly PluginId[];
  readonly keep: readonly PluginId[];
  readonly remove: readonly PluginId[];
  readonly skipped: readonly SkippedPlugin[];
  readonly state_path: string;
}

export const CODEGRAPH_CONFIG_MARKER = 'codegraph-config-projection';

function adapterHasRequiredProjection(path: string, host: HookHost, env: NodeJS.ProcessEnv): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: unknown };
    const projection = compareManagedHookProjection(parsed.hooks ?? {}, host, env);
    // A selection transition may probe still-present managed routes before the
    // installer rewrites the adapter. Extra routes are tolerated by this
    // presence probe, but any required route field drift, duplicate, or
    // missing route is not.
    return projection.error === undefined && projection.mismatches.every((mismatch) => mismatch.kind === 'unexpected');
  } catch {
    return false;
  }
}

function captureDirectoryOrLink(path: string, owner: SurfaceOwner): CapturedPath | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    // A pre-existing symlink has no embedded repo-harness ownership proof.
    // Newly created transaction symlinks are captured separately from the
    // before/after transaction snapshots.
    return null;
  }
  if (!stat.isDirectory()) return null;
  const markerPath = join(path, OWNER_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      owner?: unknown;
      surface?: unknown;
      content_hash?: unknown;
    };
    if (
      marker.owner !== 'repo-harness' ||
      (marker.surface !== 'canonical-skill' && marker.surface !== 'command-facade') ||
      typeof marker.content_hash !== 'string'
    ) return null;
    // The marker's hash is the tree hash without the marker: the record's proof.
    return { owner, path, committed: { type: 'directory', sha256: marker.content_hash } };
  } catch {
    return null;
  }
}

function captureOwnedPath(path: string, owner: SurfaceOwner): CapturedPath | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { owner, path, committed: { type: 'symlink', target: readlinkSync(path) } };
  if (stat.isDirectory()) return { owner, path, committed: { type: 'directory', sha256: hashManagedTree(path) } };
  if (!stat.isFile()) return null;
  return { owner, path, committed: { type: 'file', sha256: sha256Prefixed(readFileSync(path)) } };
}

function herdrSkillPaths(home: string, env: NodeJS.ProcessEnv): readonly string[] {
  return [...hostSkillRoots(home, env), stagedSkillRoot(home)].map((root) => join(root, 'herdr'));
}

/**
 * A Herdr skill record. Its currency is the marker proof (`ownedSkillIsIntact`), never a tree hash:
 * a later Herdr write keeps the record current, and any user entry ends rh's claim on the directory.
 */
function captureHerdrSkill(path: string, owner: SurfaceOwner): CapturedPath | null {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory() || !ownedSkillIsIntact(path)) return null;
  return { owner, path, committed: { type: 'directory', proof: 'herdr-skill-marker' } };
}

/**
 * A facade is canonical when the package still ships its source directory,
 * checked through the host's already-synced canonical `repo-harness` skill
 * copy. A name absent from the catalog's facade-kind packages (a fully
 * retired name) is never canonical.
 */
function facadeIsCanonical(root: string, name: string, catalog: SkillSurfaceCatalog): boolean {
  const source = catalog.packages.find((pkg) => pkg.kind === 'facade' && pkg.name === name)?.source;
  return typeof source === 'string' && existsSync(join(root, 'repo-harness', source, 'SKILL.md'));
}

const FACADE_NAME_PREFIX = 'repo-harness-';

const SKILL_HOSTS: readonly SkillHost[] = ['codex', 'claude', 'pi'];

function hostSkillRoots(home: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return SKILL_HOSTS.map((host) => hostSkillRoot(home, host, env));
}

/**
 * The skill hosts that a selection manages. The Pi root is the `pi` plugin's
 * surface, so discovery and probes never read it without `pi`: a copy left
 * there is not evidence and not a record.
 */
function selectedSkillHosts(plugins: readonly PluginId[]): readonly SkillHost[] {
  return SKILL_HOSTS.filter((host) => host !== 'pi' || plugins.includes('pi'));
}

/**
 * Discovery records every owner-marked repo-harness-* directory, including a
 * name that later leaves the catalog. The state reader accepts the same
 * bounded set, so a committed receipt stays readable until removal.
 */
function isDiscoveredFacadePath(path: string, home: string, env: NodeJS.ProcessEnv): boolean {
  const name = basename(path);
  return name.startsWith(FACADE_NAME_PREFIX) && hostSkillRoots(home, env).some((root) => join(root, name) === path);
}

/**
 * The plugin manifest's surface map for paths outside the skill catalog, and
 * the catalog owner for skill paths. The Pi skill root is the `pi` plugin's
 * surface, whatever package it holds. Null means that no selection owns the path.
 */
export function ownerForInstallPath(path: string, env: NodeJS.ProcessEnv = process.env): SurfaceOwner | null {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) ?? '';
  const home = env.HOME ?? homedir();
  const inSkills = normalized.includes('/skills/');
  if (inSkills && normalized.startsWith(`${hostSkillRoot(home, 'pi', env).replaceAll('\\', '/')}/`)) return 'pi';
  if (name === 'repo-harness' && inSkills) return 'core';
  if (inSkills) {
    const catalog = loadSkillSurfaceCatalog();
    const pkg = catalog.packages.find(entry => entry.name === name);
    if (pkg?.kind === 'facade' || pkg?.kind === 'provider-skill') return pkg.owner;
    // The installer writes the Herdr skill itself (configureRequiredHerdrSkill), outside the selection projection.
    if (pkg?.name === 'herdr') return pkg.owner;
    if (selectionOwnedSkillNames(catalog).includes(name)) return pkg!.owner;
    const obsidianSelection = requiredExplicitExternalDependencyInstallGroups(catalog, 'obsidian-memory', ['claude', 'codex']);
    if (obsidianSelection.status !== 'selected') {
      throw new Error(`invalid Obsidian dependency selection: ${obsidianSelection.status}:${obsidianSelection.name}`);
    }
    if (obsidianSelection.groups.some(({ skills }) => skills.includes(name))) return pkg!.owner;
  }
  if (AGENT_FLEET_FILE.test(normalized)) return 'core';
  if (wazaRules.files.includes(name) && /\/(?:\.agents|\.codex|\.claude)\/rules\/[^/]+$/.test(normalized)) return 'core';
  if (normalized.endsWith('/bin/codegraph')) return 'architecture';
  if (normalized.endsWith('/bin/archctx')) return 'architecture';
  if (normalized.endsWith('/bin/rh')) return 'core';
  // The retired 0.32 CLI link; `rh update` removes it inside the host transaction.
  if (normalized.endsWith('/bin/repo-harness')) return 'core';
  return null;
}

function discoverManagedSurfaces(
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv,
): readonly CapturedPath[] {
  const home = env.HOME ?? homedir();
  const catalog = loadSkillSurfaceCatalog();
  const surfaces: CapturedPath[] = [];
  const enabled = (owner: SurfaceOwner | null): owner is SurfaceOwner => owner !== null && ownerEnabled(owner, plugins);
  // A catalog facade can lack the prefix (obsidian-memory). Its copy needs
  // the same marker-based receipt as a prefixed facade copy.
  const facadeNames = new Set(catalog.packages.filter((pkg) => pkg.kind === 'facade').map((pkg) => pkg.name));
  const hostRoots = selectedSkillHosts(plugins).map((host) => hostSkillRoot(home, host, env));
  // The Herdr step writes its marker with the SKILL.md hash, in each selected host
  // root and in the staged root. A copy that still matches it is rh's, whichever
  // earlier run wrote it; an edited copy stays the user's.
  for (const herdr of [...hostRoots, stagedSkillRoot(home)].map((root) => join(root, 'herdr'))) {
    const owner = ownerForInstallPath(herdr, env);
    const surface = enabled(owner) ? captureHerdrSkill(herdr, owner) : null;
    if (surface) surfaces.push(surface);
  }
  for (const root of hostRoots) {
    const canonicalOwner = ownerForInstallPath(join(root, 'repo-harness'), env);
    if (enabled(canonicalOwner)) {
      const canonical = captureDirectoryOrLink(join(root, 'repo-harness'), canonicalOwner);
      if (canonical) surfaces.push(canonical);
    }
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((entry) => entry.startsWith(FACADE_NAME_PREFIX) || facadeNames.has(entry)).sort()) {
      // A retired facade keeps its receipt under `core` until skill sync removes it; in the Pi root it stays `pi`.
      const owner = facadeIsCanonical(root, name, catalog) || root === hostSkillRoot(home, 'pi', env) ? ownerForInstallPath(join(root, name), env) : 'core';
      if (!enabled(owner)) continue;
      const facade = captureDirectoryOrLink(join(root, name), owner);
      if (facade) surfaces.push(facade);
    }
  }
  const sourceRoot = bunGlobalPackageRoot(env);
  // A matching stable package or staging link is ownership proof. Never
  // acquire an arbitrary link merely because the transaction found it.
  if (sourceRoot !== null) {
    for (const projection of expectedSkillProjections(catalog, sourceRoot, home, plugins, env)) {
      if (!skillLinkMatches(projection.destination, projection.source)) continue;
      const owner = ownerForInstallPath(projection.destination, env);
      if (!enabled(owner)) continue;
      const surface = captureOwnedPath(projection.destination, owner);
      if (surface) surfaces.push(surface);
    }
  }
  return surfaces;
}

/** Generated agent fleet targets written by scripts/install-agent-fleet.sh. */
export function agentFleetTargetPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = env.HOME ?? homedir();
  return MANAGED_AGENTS.flatMap((agent) => [
    join(home, '.codex', 'agents', `${agent}.toml`),
    join(home, '.claude', 'agents', `${agent}.md`),
  ]);
}

/** The path records that a producer edits, by key. */
type RecordMap = Map<string, PathRecord>;

/**
 * A captured path as a `created` path record. An existing record keeps its
 * baseline; otherwise a path that the transaction snapshot found absent is
 * `known, existed: false`, and one that discovery found is `unknown`. A
 * `user_managed` record is the user's file: no capture claims it.
 */
function recordCapture(env: NodeJS.ProcessEnv, records: RecordMap, capture: CapturedPath, prior: PathRecords, absent: ReadonlySet<string> = new Set()): void {
  const host = pathRecordHost(env, capture.path);
  if (host === null) throw new Error(`no install root holds the captured path: ${capture.path}`);
  const key = pathRecordKey(env, capture.path);
  const previous = prior[key];
  if (previous?.kind === 'user_managed' || records.get(key)?.kind === 'user_managed') return;
  const baseline: FileBaseline = previous?.baseline ?? (absent.has(capture.path) ? { state: 'known', existed: false } : { state: 'unknown' });
  // A file that replaced a user file keeps its kind and the vault reference of that file.
  const kind = previous?.kind === 'replaced' ? { kind: 'replaced' as const, backup: previous.backup! } : { kind: 'created' as const };
  records.set(key, { owner: capture.owner, host, baseline, committed: capture.committed, ...kind });
}

function ownerSelected(record: PathRecord, plugins: readonly PluginId[]): boolean {
  return record.kind === 'user_managed' || (isSurfaceOwner(record.owner) && ownerEnabled(record.owner, plugins));
}

/** The records that a selection commits: no record of a plugin outside `plugins`. */
function selectionRecords(records: RecordMap, plugins: readonly PluginId[]): Record<string, PathRecord> {
  return Object.fromEntries([...records].filter(([, record]) => ownerSelected(record, plugins)));
}

/**
 * The current records that a rebuilt set carries: each path still on disk
 * unchanged, each `user_managed` record, each `replaced` record (it holds the
 * vault reference of a user file), and every record of a kept plugin.
 */
function carriedRecords(prior: PathRecords, kept: readonly PluginId[] = []): RecordMap {
  return new Map(Object.entries(prior).filter(([key, record]) => (
    record.kind === 'user_managed' || record.kind === 'replaced' || (kept as readonly string[]).includes(record.owner) || pathRecordIsCurrent(key, record)
  )));
}

/**
 * Fleet files written before ownership tracking, or during an update, are never
 * transaction-created, so a later fleet projection change would report them as
 * drift. Right after a successful fleet run every target is either the generated
 * projection or a file that the user keeps (a `user_managed` record); only the former is recorded.
 */
function verifiedAgentFleetSurfaces(env: NodeJS.ProcessEnv, prior: PathRecords): readonly CapturedPath[] {
  return agentFleetTargetPaths(env).flatMap((path) => {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || prior[pathRecordKey(env, path)]?.kind === 'user_managed') return [];
    const surface = captureOwnedPath(path, 'core');
    return surface ? [surface] : [];
  });
}

/**
 * Update paths run the fleet helper but may never reach applyInstallSelection
 * (partial or in-process reconciliation), so the verified fleet files are
 * recorded right after the helper succeeds. Without installed state there is
 * no install to extend.
 */
export function recordVerifiedAgentFleetOwnership(env: NodeJS.ProcessEnv = process.env): void {
  if (readInstallState(env) === null) return;
  const prior = readPathRecords(env);
  const records: RecordMap = new Map(Object.entries(prior));
  for (const surface of verifiedAgentFleetSurfaces(env, prior)) recordCapture(env, records, surface, prior);
  writePathRecords(env, Object.fromEntries(records));
}

/** Refresh held records. Callers must prove ownership of each newly claimed path. */
export function recordRefreshedInstallOwnership(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  newlyOwnedPaths: readonly string[] = [],
): void {
  const current = readInstallState(env);
  if (current === null) return;
  const selected = new Set(paths);
  const plugins = enabledPlugins(current);
  const prior = readPathRecords(env);
  const records: RecordMap = new Map(Object.entries(prior));
  for (const path of selected) {
    const key = pathRecordKey(env, path);
    const record = prior[key];
    // A Herdr record proves itself by its marker; a user's file is never refreshed.
    if (!record || record.kind !== 'created' || 'proof' in record.committed) continue;
    const refreshed = captureOwnedPath(path, record.owner as SurfaceOwner);
    if (!refreshed || refreshed.committed.type !== record.committed.type) throw new Error(`cannot refresh install ownership: ${path}`);
    records.set(key, { ...record, committed: refreshed.committed });
  }
  for (const path of new Set(newlyOwnedPaths)) {
    if (!selected.has(path)) throw new Error(`new install ownership path is outside this refresh: ${path}`);
    if (records.has(pathRecordKey(env, path))) continue;
    const owner = ownerForInstallPath(path, env);
    if (owner === null || !ownerEnabled(owner, plugins)) throw new Error(`no enabled owner for new install ownership: ${path}`);
    const created = captureOwnedPath(path, owner);
    if (!created) throw new Error(`cannot record new install ownership: ${path}`);
    recordCapture(env, records, created, prior);
  }
  if (!writePathRecords(env, Object.fromEntries(records))) return;
  writeState({ ...current, ...versions(plugins) }, env);
}

/** A Pi package source that an install may own: the Bun global package root, with the `pi` plugin enabled. */
function validPiPackage(source: string, env: NodeJS.ProcessEnv, plugins: readonly PluginId[]): boolean {
  return plugins.includes('pi') && source === bunGlobalPackageRoot(env);
}

export function recordPiInstallOwnership(sources: readonly string[], env: NodeJS.ProcessEnv = process.env, transaction?: HostSurfaceSnapshots): void {
  const current = readInstallState(env);
  if (current === null) {
    if (sources.length === 0) return;
    throw new Error('Pi package ownership requires an install state');
  }
  const plugins = enabledPlugins(current);
  if (sources.some(source => !validPiPackage(source, env, plugins))) throw new Error('invalid Pi package ownership');
  if (transaction) {
    const root = hostSkillRoot(env.HOME ?? homedir(), 'pi', env);
    const prior = readPathRecords(env);
    const records: RecordMap = new Map(Object.entries(prior));
    const { captures, absent } = transactionOwnedSurfaces(transaction, prior, env);
    for (const surface of captures) {
      if (ownerEnabled(surface.owner, plugins) && surface.path.startsWith(root + '/')) recordCapture(env, records, surface, prior, absent);
    }
    writePathRecords(env, Object.fromEntries(records));
  }
  const piPackages = [...new Set([...current.pi_packages, ...sources])];
  if (piPackages.length !== current.pi_packages.length) writeState({ ...current, pi_packages: piPackages }, env);
}

/** Preserve only the external resources that rollback could not remove. */
export function recordUnresolvedPiOwnership(
  selection: PluginSelection,
  plugins: readonly PluginId[],
  sources: readonly string[],
  env: NodeJS.ProcessEnv,
  transactionId: string,
): void {
  if (sources.length === 0) return;
  const current = readInstallState(env);
  // The state records the attempted selection. Probes still report the
  // missing filesystem surfaces of an incomplete, rolled-back installation.
  const state: InstallState = current ?? {
    protocol: INSTALL_STATE_PROTOCOL, ...versions(plugins), selection,
    transaction_id: transactionId, applied_at: new Date().toISOString(), pi_packages: [], previous: null,
  };
  if (sources.some(source => !validPiPackage(source, env, enabledPlugins(state)))) throw new Error('invalid Pi rollback ownership');
  writeState({ ...state, pi_packages: [...new Set([...state.pi_packages, ...sources])] }, env);
}

/** Candidate processes publish Pi packages into the same state as the parent. */
export function newPiPackagesSinceTransaction(transaction: InstallHostTransaction, env: NodeJS.ProcessEnv): readonly string[] {
  const snapshot = transaction.snapshots.find(entry => entry.path === installProfileStatePath(env));
  const before = snapshot?.existed && snapshot.backup_path
    ? checkedState(parseRecordedInstallState(JSON.parse(readFileSync(snapshot.backup_path, 'utf8')), snapshot.backup_path), snapshot.backup_path, env).pi_packages
    : [];
  return (readInstallState(env)?.pi_packages ?? []).filter(source => !before.includes(source));
}

/**
 * The mandatory runtime dependencies that repo-harness pins in its package
 * dependencies. Bun hoists them beside the CLI package, so a CLI install
 * rewrites them and a host transaction must restore them with the CLI.
 */
export const ARCHCTX_PACKAGES = ['archctx', 'archctx-contracts'] as const;

export function installProfileHostMutationPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = env.HOME ?? homedir();
  const bunRoot = env.BUN_INSTALL ?? join(home, '.bun');
  const { repoHarnessSkills: skills, externalSkills } = catalogMutationPathSkillNames(loadSkillSurfaceCatalog());
  const paths = [
    join(bunRoot, 'bin', 'rh'),
    join(bunRoot, 'bin', RETIRED_CLI_NAME),
    join(bunRoot, 'bin', 'archctx'),
    join(bunRoot, 'bin', 'codegraph'),
    join(bunRoot, 'install', 'global', 'package.json'),
    join(bunRoot, 'install', 'global', 'bun.lock'),
    join(bunRoot, 'install', 'global', 'bun.lockb'),
    join(bunRoot, 'install', 'global', 'node_modules', 'repo-harness'),
    join(bunRoot, 'install', 'global', 'node_modules', '@colbymchenry', 'codegraph'),
    ...ARCHCTX_PACKAGES.map(name => join(bunRoot, 'install', 'global', 'node_modules', name)),
    join(home, '.codex', 'hooks.json'),
    join(home, '.codex', 'config.toml'),
    // The gate writes the file that a dotfile link names, so the snapshot holds that file as well as the link.
    resolveHostPath(hostConfigPaths(env), join(home, '.codex', 'config.toml')),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude.json'),
    join(home, '.repo-harness', 'config.json'),
    installProfileStatePath(env),
    configurationReceiptPath(home),
    // A rollback that restores `~/.codex/config.toml` restores its ledger records with it.
    hostConfigPaths(env).ledger,
    providerSkillLock(home, env).path,
  ];
  for (const root of hostSkillRoots(home, env)) {
    for (const skill of [...skills, ...externalSkills]) paths.push(join(root, skill));
  }
  for (const skill of externalSkills) {
    paths.push(join(stagedSkillRoot(home), skill));
  }
  for (const rule of wazaRules.files) {
    paths.push(
      join(home, '.agents', 'rules', rule),
      join(home, '.codex', 'rules', rule),
      join(home, '.claude', 'rules', rule),
    );
  }
  paths.push(...agentFleetTargetPaths(env));
  // Install and update rewrite the managed Global Working Rules block. A path
  // whose copy would fail (unreadable or special file) stays out of the
  // backup; the rules plan skips that file and never writes it.
  for (const host of ['codex', 'claude'] as const) {
    const path = globalContextPath(home, host);
    if (globalContextBackupEligible(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

/**
 * The install surfaces that a path record may name: the host mutation paths,
 * and a repo-harness-* facade in a host skill root (also one that later left
 * the catalog), by key; a `user_managed` record names a fleet file only; the
 * owner is `core` or a plugin. The protocol 3 reader accepted the same set. A
 * record outside it never grants a write or a removal.
 */
export function supportedPathRecord(env: NodeJS.ProcessEnv): (key: string, record: PathRecord) => boolean {
  const keyOf = (path: string): string | null => {
    try { return pathRecordKey(env, path); } catch { return null; }
  };
  const keys = (paths: readonly string[]) => new Set(paths.map(keyOf).filter((key): key is string => key !== null));
  const allowed = keys(installProfileHostMutationPaths(env));
  const fleet = keys(agentFleetTargetPaths(env));
  const facadeRoots = new Set([...keys(hostSkillRoots(env.HOME ?? homedir(), env).map((root) => join(root, FACADE_NAME_PREFIX)))].map((key) => dirname(key)));
  return (key, record) => isSurfaceOwner(record.owner) && (record.kind === 'user_managed'
    ? fleet.has(key)
    : allowed.has(key) || (basename(key).startsWith(FACADE_NAME_PREFIX) && facadeRoots.has(dirname(key))));
}

registerSupportedPathRecords(supportedPathRecord);

function skippedOwnership(env: NodeJS.ProcessEnv): Pick<InstallStateStatus, 'ownership_outside_root' | 'ownership_unsupported'> {
  const { outside, unsupported } = readPathRecordSet(env);
  return { ownership_outside_root: outside, ownership_unsupported: unsupported };
}

/**
 * The skill roots that scripts/sync-codex-installed-copies.sh writes for a
 * selection. The shell reads the same syncSkillRoots result from
 * skill-surface-select.ts.
 */
export function effectiveSkillRoots(plugins: readonly PluginId[], env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const roots = syncSkillRoots(env, env.HOME ?? homedir(), plugins);
  return [roots.codex, roots.claude, roots.pi].filter((root): root is string => root !== null);
}

/**
 * Skill sync also retires repo-harness-* facades and owned dangling links
 * that the current catalog does not name. A host transaction snapshots that
 * full set before sync runs.
 */
export function installProfileTransactionPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const { repoHarnessSkills } = catalogMutationPathSkillNames(loadSkillSurfaceCatalog());
  const paths = [...installProfileHostMutationPaths(env)];
  // The snapshot covers every root that any selection's sync can write.
  for (const root of effectiveSkillRoots(PLUGIN_IDS, env)) {
    for (const skill of repoHarnessSkills) paths.push(join(root, skill));
    // Follow a linked root, as the shell's [[ -d ]] test does.
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (name.startsWith(FACADE_NAME_PREFIX) || (lstatSync(path).isSymbolicLink() && !existsSync(path))) paths.push(path);
    }
  }
  return [...new Set(paths)];
}

const transactionLocks = new WeakMap<InstallHostTransaction, { context: RuntimeTransactionContext; owned: RuntimeTransactionLock | undefined }>();

const TRANSACTION_PREFIX = 'install-';
/** The process that runs a transaction, in the lock owner's shape (PID and start time), and the paths that it snapshots by index. */
const TRANSACTION_OWNER = 'owner.json';

interface TransactionOwner {
  readonly pid: number;
  readonly startTime: string | null;
  readonly paths: readonly string[];
}

/** `none`: an earlier rh version wrote no record. `invalid`: the record proves nothing, so the directory stays. */
function readTransactionOwner(directory: string): TransactionOwner | 'none' | 'invalid' {
  const path = join(directory, TRANSACTION_OWNER);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 'none';
  if (!stat.isFile()) return 'invalid';
  let record: { pid?: unknown; start_time?: unknown; paths?: unknown };
  try { record = JSON.parse(readFileSync(path, 'utf-8')); } catch { return 'invalid'; }
  if (!Number.isSafeInteger(record?.pid) || (record.pid as number) <= 0
    || !Array.isArray(record.paths) || !record.paths.every((entry) => typeof entry === 'string')) return 'invalid';
  const startTime = typeof record.start_time === 'string' && record.start_time !== '' ? record.start_time : null;
  return { pid: record.pid as number, startTime, paths: record.paths as string[] };
}

/**
 * Settle one copy against its host path. A copy equal to the host bytes goes.
 * A file copy that differs, or whose host file is gone, can be the only
 * preimage of that file, so it moves to the private vault. A link or directory
 * copy that differs stays where it is.
 */
function settleTransactionCopy(copy: string, host: string, env: NodeJS.ProcessEnv): void {
  const copied = lstatSync(copy);
  const current = lstatSync(host, { throwIfNoEntry: false });
  if (copied.isFile()) {
    const bytes = readFileSync(copy);
    if (!current?.isFile() || !readFileSync(host).equals(bytes)) {
      const paths = hostConfigPaths(env);
      ensurePrivateDirectory(paths.vault);
      const vaulted = join(paths.vault, putVault(paths, bytes).slice('sha256:'.length));
      process.stderr.write(`[install] ${host} is not as a killed install found it; its earlier bytes are in ${vaulted}\n`);
    }
    rmSync(copy);
    return;
  }
  const same = copied.isSymbolicLink()
    ? current?.isSymbolicLink() === true && readlinkSync(host) === readlinkSync(copy)
    : copied.isDirectory() && current?.isDirectory() === true && hashManagedTree(host) === hashManagedTree(copy);
  if (same) rmSync(copy, { recursive: true, force: true });
  else process.stderr.write(`[install] kept ${copy}: it differs from ${host}\n`);
}

/**
 * A killed install leaves its directory with copies of host files, credentials
 * included. The lock holder settles each copy of a directory whose owner ended
 * and removes the directory once only its record is left. Nothing is restored
 * to a host path: the directory does not record which host files the killed
 * run changed. A directory without a record (an earlier rh version) stays, as
 * does a retained upgrade backup (`manifest.json`); a link is never followed.
 */
function settleOrphanedTransactions(transactionRoot: string, env: NodeJS.ProcessEnv): void {
  for (const name of readdirSync(transactionRoot)) {
    const directory = join(transactionRoot, name);
    // A run killed before its rename leaves a staging directory with at most its owner record and no copies.
    const staging = name.startsWith('.staging-');
    // An unlocked transaction (`rh init`) may remove its own directory while the sweep reads it.
    if (!(staging || name.startsWith(TRANSACTION_PREFIX)) || !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() || lstatExists(join(directory, 'manifest.json'))) continue;
    const owner = readTransactionOwner(directory);
    if (owner === 'none') {
      if (!staging && lstatExists(directory)) process.stderr.write(`[install] kept the install transaction of an earlier rh version: ${directory}\n`);
      continue;
    }
    if (owner === 'invalid' || exclusiveDirectoryLockOwnerLiveness({ lockPath: directory, pid: owner.pid, startTime: owner.startTime, token: '' }) !== 'dead') continue;
    for (const entry of readdirSync(directory)) {
      const host = /^\d+$/.test(entry) ? owner.paths[Number(entry)] : undefined;
      if (host !== undefined) settleTransactionCopy(join(directory, entry), host, env);
    }
    if (readdirSync(directory).every((entry) => entry === TRANSACTION_OWNER)) rmSync(directory, { recursive: true, force: true });
  }
}

/** A candidate runs under its parent's lock, so only the process that holds the lock removes orphans. */
function holdsRuntimeLock(scope: RuntimeTransactionScope): boolean {
  return readExclusiveDirectoryLockOwner(realpathSync(scope.root), runtimeTransactionLockRelativePath(scope))?.pid === process.pid;
}

/** The owner record goes in before the directory gets its `install-` name, so no live directory is ever without one. */
function createTransactionDirectory(transactionRoot: string, paths: readonly string[]): string {
  const staging = mkdtempSync(join(transactionRoot, '.staging-'));
  const directory = join(transactionRoot, `${TRANSACTION_PREFIX}${randomUUID()}`);
  try {
    writeFileSync(join(staging, TRANSACTION_OWNER), `${JSON.stringify({ pid: process.pid, start_time: currentProcessStartTime(), paths })}\n`, { mode: 0o600 });
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

export function beginInstallHostTransaction(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly retainBackup?: boolean; readonly runtimeLock?: RuntimeTransactionContext } = {},
): InstallHostTransaction {
  const scope = globalRuntimeScope(env);
  const containsConfig = paths.includes(globalConfigurationPath(env)) || paths.includes(join(scope.root, '.repo-harness', 'config.json'));
  let owned: RuntimeTransactionLock | undefined;
  const context = containsConfig ? options.runtimeLock ?? (owned = acquireRuntimeTransactionLock(scope)) : options.runtimeLock;
  try {
    if (context) assertRuntimeTransactionContext(context, scope);
    if (containsConfig) mutateGlobalConfiguration(env, () => ({ value: undefined }), { runtimeLock: context });
    const transactionRoot = runtimeTransactionRoot(scope);
    mkdirSync(transactionRoot, { recursive: true });
    if (context && holdsRuntimeLock(scope)) settleOrphanedTransactions(transactionRoot, env);
    const unique = [...new Set(paths)];
    const backupRoot = createTransactionDirectory(transactionRoot, unique);
    try {
      const snapshots = unique.map((path, index): HostSurfaceSnapshot => {
        if (!existsSync(path) && !lstatExists(path)) return { path, existed: false, backup_path: null };
        const backupPath = join(backupRoot, String(index));
        cpSync(path, backupPath, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
        return { path, existed: true, backup_path: backupPath };
      });
      const transaction: InstallHostTransaction = { protocol: 1, backup_root: backupRoot, snapshots };
      if (context) transactionLocks.set(transaction, { context, owned });
      if (options.retainBackup === true) {
        writeFileSync(join(backupRoot, 'manifest.json'), `${JSON.stringify(transaction, null, 2)}\n`, { mode: 0o600 });
      }
      return transaction;
    } catch (error) {
      rmSync(backupRoot, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    owned?.release();
    throw error;
  }
}

function isGlobalConfigurationSnapshot(path: string): boolean {
  return path.replaceAll('\\', '/').endsWith('/.repo-harness/config.json');
}

function assertTransactionLock(transaction: InstallHostTransaction, context?: RuntimeTransactionContext): void {
  const held = transactionLocks.get(transaction)?.context ?? context;
  if (held) {
    assertRuntimeTransactionContext(held, held.scope);
    for (const snapshot of transaction.snapshots) {
      if (isGlobalConfigurationSnapshot(snapshot.path)) assertRuntimeTransactionContext(held, process.platform === 'win32' ? globalRuntimeScope() : { kind: 'global', root: dirname(dirname(snapshot.path)) });
    }
    return;
  }
  if (transaction.snapshots.some(snapshot => isGlobalConfigurationSnapshot(snapshot.path))) {
    throw new Error('configuration rollback requires its original runtime transaction context');
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function rollbackInstallHostTransaction(
  transaction: InstallHostTransaction,
  options: { readonly retainBackup?: boolean; readonly runtimeLock?: RuntimeTransactionContext;
    readonly unresolvedPi?: { readonly selection: PluginSelection; readonly plugins: readonly PluginId[]; readonly sources: readonly string[]; readonly env: NodeJS.ProcessEnv } } = {},
): void {
  assertTransactionLock(transaction, options.runtimeLock);
  try {
    const failures: string[] = [];
    const unresolved = options.unresolvedPi;
    if (unresolved?.sources.length) {
      try {
        writeFileSync(join(transaction.backup_root, 'pi-ownership.json'), JSON.stringify({ protocol: 1,
          transaction_id: basename(transaction.backup_root), plugins: unresolved.plugins, pi_packages: unresolved.sources }), { mode: 0o600 });
      } catch (error) { failures.push(`Pi recovery record: ${String((error as Error).message ?? error)}`); }
    }
    // The gate undoes its own text writes by the ledger records before the ledger file goes back, so a linked host file needs no copy here.
    // The snapshot below still restores the whole paths, so the gate gets no transaction directory for them.
    const ledger = transaction.snapshots.find((snapshot) => basename(snapshot.path) === 'ledger.json' && basename(dirname(snapshot.path)) === 'config');
    if (ledger) {
      try {
        const result = rollbackHostConfigTransaction(dirname(dirname(ledger.path)), ledger.existed && ledger.backup_path !== null ? readFileSync(ledger.backup_path) : null, null);
        failures.push(...result.unresolved.map((entry) => `${entry}: rh cannot prove this host configuration entry, so it stays as it is`));
      } catch (error) { failures.push(`host configuration rollback: ${String((error as Error).message ?? error)}`); }
    }
    for (const snapshot of [...transaction.snapshots].reverse()) {
      try {
        if (isGlobalConfigurationSnapshot(snapshot.path)) {
          const context = transactionLocks.get(transaction)?.context ?? options.runtimeLock;
          if (!context) throw new Error('configuration rollback lost its runtime transaction context');
          restoreGlobalConfiguration(snapshot.path, snapshot.existed && snapshot.backup_path !== null ? readFileSync(snapshot.backup_path) : null, context);
          continue;
        }
        // A path under a regular file cannot exist, so an absent snapshot there is already restored.
        if (!snapshot.existed && lstatSync(dirname(snapshot.path), { throwIfNoEntry: false })?.isFile()) continue;
        if (snapshot.existed && snapshot.backup_path !== null && !lstatExists(snapshot.backup_path)) throw new Error(`its backup ${snapshot.backup_path} is missing, so the path stays as it is`);
        rmSync(snapshot.path, { recursive: true, force: true });
        if (snapshot.existed && snapshot.backup_path !== null) {
          mkdirSync(dirname(snapshot.path), { recursive: true });
          cpSync(snapshot.backup_path, snapshot.path, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
          });
        }
      } catch (error) {
        failures.push(`${snapshot.path}: ${String((error as Error).message ?? error)}`);
      }
    }
    if (unresolved?.sources.length) {
      try { recordUnresolvedPiOwnership(unresolved.selection, unresolved.plugins, unresolved.sources, unresolved.env, basename(transaction.backup_root)); }
      catch (error) { failures.push(`Pi ownership could not be restored to the ledger; recovery transaction ${transaction.backup_root}: ${String((error as Error).message ?? error)}`); }
    }
    if (failures.length === 0 && options.retainBackup !== true) {
      rmSync(transaction.backup_root, { recursive: true, force: true });
    }
    if (failures.length > 0) throw new Error(`install transaction compensation failed:\n${failures.join('\n')}`);
  } finally {
    transactionLocks.get(transaction)?.owned?.release();
    transactionLocks.delete(transaction);
  }
}

export function commitInstallHostTransaction(transaction: InstallHostTransaction): void {
  assertTransactionLock(transaction);
  rmSync(transaction.backup_root, { recursive: true, force: true });
  transactionLocks.get(transaction)?.owned?.release();
  transactionLocks.delete(transaction);
}

/**
 * Candidate-owned paths, with their existence before setup. The candidate has
 * no backups, and these paths do not need one for ownership capture.
 */
export function piSkillRootSnapshots(env: NodeJS.ProcessEnv = process.env): HostSurfaceSnapshots {
  const root = `${hostSkillRoot(env.HOME ?? homedir(), 'pi', env)}/`;
  const archctx = join(env.BUN_INSTALL ?? join(env.HOME ?? homedir(), '.bun'), 'bin', 'archctx');
  return {
    snapshots: installProfileTransactionPaths(env)
      .filter(path => path.startsWith(root) || path === archctx)
      .map(path => ({ path, existed: existsSync(path) || lstatExists(path), backup_path: null })),
  };
}

/**
 * The paths that a transaction wrote: each path absent before it with an
 * owner, and each existing path that already has a `created` record. `absent`
 * holds the paths that the snapshot found absent, for their baseline.
 */
function transactionOwnedSurfaces(
  transaction: HostSurfaceSnapshots,
  prior: PathRecords,
  env: NodeJS.ProcessEnv,
): { readonly captures: readonly CapturedPath[]; readonly absent: ReadonlySet<string> } {
  const herdr = herdrSkillPaths(env.HOME ?? homedir(), env);
  const captures = transaction.snapshots.flatMap((snapshot) => {
    // The marker proof alone records a Herdr directory, whatever an earlier record held.
    if (herdr.includes(snapshot.path)) {
      const owner = ownerForInstallPath(snapshot.path, env);
      const surface = owner === null ? null : captureHerdrSkill(snapshot.path, owner);
      return surface ? [surface] : [];
    }
    if (snapshot.existed) {
      // A snapshot outside every install root, such as the install state, has no path record.
      if (pathRecordHost(env, snapshot.path) === null) return [];
      const previous = prior[pathRecordKey(env, snapshot.path)];
      if (previous?.kind !== 'created' || !isSurfaceOwner(previous.owner)) return [];
      const refreshed = captureOwnedPath(snapshot.path, previous.owner);
      return refreshed ? [refreshed] : [];
    }
    const owner = ownerForInstallPath(snapshot.path, env);
    if (owner === null) return [];
    const surface = captureOwnedPath(snapshot.path, owner);
    return surface ? [surface] : [];
  });
  return { captures, absent: new Set(transaction.snapshots.filter((snapshot) => !snapshot.existed).map((snapshot) => snapshot.path)) };
}

function removeOwnedSkillLockEntries(env: NodeJS.ProcessEnv, skillNames: ReadonlySet<string>): void {
  if (skillNames.size === 0) return;
  const lockPath = providerSkillLock(env.HOME ?? homedir(), env).path;
  if (!existsSync(lockPath)) return;
  const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { skills?: Record<string, unknown> };
  if (!parsed || typeof parsed !== 'object' || !parsed.skills || typeof parsed.skills !== 'object') {
    throw new Error(`invalid external skill lock: ${lockPath}`);
  }
  for (const name of skillNames) delete parsed.skills[name];
  const temp = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  retryWindowsSharingRace(() => renameSync(temp, lockPath));
}

/**
 * Remove the owned paths and Pi packages of each plugin that the target
 * selection drops. A changed path stops the switch. The gate undoes each path
 * and drops its record, and keeps its entry in `transaction` for a rollback.
 */
function removeRetiredOwnedSurfaces(
  plugins: readonly PluginId[],
  current: Pick<InstallState, 'pi_packages'>,
  env: NodeJS.ProcessEnv,
  transaction: string,
): readonly string[] {
  const records = readPathRecords(env);
  const retired = Object.keys(records).filter((key) => !ownerSelected(records[key]!, plugins));
  const planned = retired.find((key) => planPathRevert(key, records[key]!) === 'kept_edited');
  if (planned) throw new Error(`refusing plugin switch because managed surface drifted: ${planned}`);
  const ownedSkills = new Set(selectionOwnedSkillNames(loadSkillSurfaceCatalog()));
  const removedSkills = new Set(retired.filter((key) => records[key]!.host === 'staged' && ownedSkills.has(basename(key))).map((key) => basename(key)));
  // Only a registration that this install created is in the state.
  const piPackages = plugins.includes('pi') ? [] : current.pi_packages;
  for (const source of piPackages) removePiPackage(source, env);
  const changed = openHostConfigGate({ env }).revertPaths(retired, { transaction }).find((entry) => entry.action === 'kept_edited');
  if (changed) throw new Error(`refusing plugin switch because managed surface drifted: ${changed.path}`);
  removeOwnedSkillLockEntries(env, removedSkills);
  return [...piPackages, ...retired];
}

/**
 * The architecture plugin's fragments in the host files (the CodeGraph table
 * and server, and its tool rule) go with the plugin, through the gate's
 * per-fragment rule: a fragment that the user changed stays, and an override
 * is never restored here, so only a whole-file revert gives a user's value back.
 */
function removeArchitectureHostFragments(env: NodeJS.ProcessEnv): void {
  const home = env.HOME ?? homedir();
  const files = [join(home, '.codex', 'config.toml'), join(home, '.claude.json'), join(home, '.claude', 'settings.json')];
  openHostConfigGate({ env }).revert(files, { owner: 'architecture' });
}

export function prepareInstallSelectionSwitch(
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv,
  transaction: string,
): readonly string[] {
  // The old records of the host files move to the ledger first, so the architecture revert below finds them.
  migrateCodexConfigRecords(env);
  migrateJsonConfigRecords(env);
  const current = readInstallState(env);
  if (!current) return [];
  const removed = removeRetiredOwnedSurfaces(plugins, current, env, transaction);
  if (!ownerEnabled('architecture', plugins)) removeArchitectureHostFragments(env);
  return removed;
}

/** The path allowlist, type and hash shape of a protocol 3 ownership surface. */
function validSurfaceShape(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  if (raw.type === 'pi-package') {
    return raw.authority === 'repo-harness-install-transaction' && raw.removal === 'managed-surfaces-only'
      && raw.path === bunGlobalPackageRoot(env) && raw.managed_marker === 'pi-package-source'
      && raw.content_hash === null && raw.symlink_target === null;
  }
  const allowedPaths = new Set(installProfileHostMutationPaths(env));
  return (
    raw.authority === 'repo-harness-install-transaction'
    && raw.removal === 'managed-surfaces-only'
    && typeof raw.path === 'string'
    && (allowedPaths.has(raw.path) || isDiscoveredFacadePath(raw.path, env.HOME ?? homedir(), env))
    && ['directory-copy', 'symlink', 'managed-file'].includes(String(raw.type))
    && (raw.content_hash === null || typeof raw.content_hash === 'string')
    && (raw.managed_marker === null || typeof raw.managed_marker === 'string')
    && (raw.symlink_target === null || typeof raw.symlink_target === 'string')
    && (raw.type === 'symlink'
      ? raw.symlink_target !== null && raw.content_hash === null && raw.managed_marker === null
      : raw.symlink_target === null && typeof raw.content_hash === 'string' && typeof raw.managed_marker === 'string')
  );
}

const SURFACE_KEYS = ['authority', 'content_hash', 'managed_marker', 'owner', 'path', 'removal', 'symlink_target', 'type'].join(',');

/** The check of one protocol 3 `ownership_manifest` surface, for the one-shot migration (install-state-migration.ts) only. */
export function isLegacyOwnershipSurface(raw: unknown, env: NodeJS.ProcessEnv, plugins: readonly PluginId[]): boolean {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== SURFACE_KEYS) return false;
  if (!isSurfaceOwner(raw.owner) || !ownerEnabled(raw.owner, plugins)) return false;
  if (raw.type === 'pi-package' && raw.owner !== 'pi') return false;
  return validSurfaceShape(raw, env);
}

/** The read model's state with each Pi package checked against the plugins of the same snapshot; the installer commands read state only through this. */
function checkedState(recorded: RecordedInstallState, path: string, env: NodeJS.ProcessEnv): InstallState {
  for (const snapshot of [recorded, ...(recorded.previous ? [recorded.previous] : [])]) {
    if (snapshot.pi_packages.some((source) => !validPiPackage(source, env, enabledPlugins(snapshot)))) throw invalidOwnership(path);
  }
  return recorded;
}

export function readInstallState(env: NodeJS.ProcessEnv = process.env): InstallState | null {
  const recorded = readRecordedInstallState(env);
  return recorded === null ? null : checkedState(recorded, installProfileStatePath(env), env);
}

/** `update` resolves the recorded selection; without a state it has none. */
export function requireInstallState(env: NodeJS.ProcessEnv = process.env): InstallState {
  const state = readInstallState(env);
  if (state === null) {
    const path = installProfileStatePath(env);
    throw new InstallStateError('install_state_missing', path, `no install state at ${path}; run: rh install`);
  }
  return state;
}

function existing(paths: readonly string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

function canonicalEvidence(home: string, hosts: readonly SkillHost[], relativePaths: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return existing(hosts.flatMap((host) => relativePaths.map((relative) => join(hostSkillRoot(home, host, env), 'repo-harness', relative))));
}

function executableEvidence(name: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  const bunRoot = env.BUN_INSTALL ?? join(home, '.bun');
  const candidates = [join(bunRoot, 'bin', name)];
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(directory, name));
  return existing([...new Set(candidates)]);
}

/** The facades and provider skills that an owner's probe requires. */
function ownedProbeSkills(catalog: SkillSurfaceCatalog, owner: SurfaceOwner) {
  return catalog.packages.filter(pkg => (pkg.kind === 'facade' || pkg.kind === 'provider-skill') && pkg.owner === owner && !pkg.explicitOnly);
}

/**
 * Each host root requires the owned skills that list its host. The set is
 * present when one root holds its non-empty required set completely.
 */
function completeHostSkillSetEvidence(home: string, hosts: readonly SkillHost[], packages: ReturnType<typeof ownedProbeSkills>, env: NodeJS.ProcessEnv): string[] {
  for (const host of hosts) {
    const root = hostSkillRoot(home, host, env);
    const paths = packages.filter(pkg => pkg.hosts.includes(host)).map(pkg => join(root, pkg.name, 'SKILL.md'));
    if (paths.length > 0 && paths.every(existsSync)) return paths;
  }
  return [];
}

function completeAgentFleetEvidence(home: string): string[] {
  for (const [root, extension] of [[join(home, '.codex', 'agents'), '.toml'], [join(home, '.claude', 'agents'), '.md']] as const) {
    const paths = MANAGED_AGENTS.map((agent) => join(root, `${agent}${extension}`));
    if (paths.every(existsSync)) return paths;
  }
  return [];
}

function probe(checks: Readonly<Record<string, readonly string[]>>): OwnerProbe {
  const missing = Object.entries(checks).filter(([, evidence]) => evidence.length === 0).map(([name]) => name);
  return { status: missing.length === 0 ? 'present' : 'missing', evidence: Object.values(checks).flat(), missing };
}

function allOrNone(home: string, hosts: readonly SkillHost[], relativePaths: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const evidence = canonicalEvidence(home, hosts, relativePaths, env);
  return relativePaths.every((relative) => evidence.some((path) => path.endsWith(relative))) ? evidence : [];
}

function probeCore(env: NodeJS.ProcessEnv, catalog: SkillSurfaceCatalog, hosts: readonly SkillHost[]): OwnerProbe {
  const home = env.HOME ?? homedir();
  const adapters = ([
    { path: join(home, '.codex', 'hooks.json'), host: 'codex' },
    { path: join(home, '.claude', 'settings.json'), host: 'claude' },
  ] as const).filter(({ path, host }) => existsSync(path) && adapterHasRequiredProjection(path, host, env)).map(({ path }) => path);
  const fleet = completeAgentFleetEvidence(home);
  const coreFacades = ownedProbeSkills(catalog, 'core').filter(pkg => pkg.kind === 'facade');
  return probe({
    'cli': executableEvidence('rh', env),
    'effective-state': canonicalEvidence(home, hosts, ['src/cli/commands/state.ts'], env),
    // The mutation guard is an in-process handler bundled in the canonical copy.
    'guards': allOrNone(home, hosts, ['src/cli/hook/mutation-guard.ts', 'scripts/contract-worktree.sh'], env),
    'handoff': canonicalEvidence(home, hosts, ['references/handoff.md'], env),
    'host-adapters': adapters,
    'workflow': canonicalEvidence(home, hosts, ['src/core/workflow/profile.ts'], env),
    'core-skills': completeHostSkillSetEvidence(home, hosts, coreFacades, env),
    'agent-fleet': fleet,
    'verifier': fleet.some((path) => /\/gatekeeper\.(?:toml|md)$/.test(path))
      ? canonicalEvidence(home, hosts, ['src/effects/review-runner/task-oar-host.ts'], env)
      : [],
    'release-gates': allOrNone(home, hosts, ['scripts/verify-sprint.sh', 'scripts/ship-worktrees.sh'], env),
  });
}

/** The Pi plugin's real state: the `pi` executable and its user package entry for this package. A failed `pi list` throws. */
function probePi(env: NodeJS.ProcessEnv): OwnerProbe {
  const source = bunGlobalPackageRoot(env);
  if (piExecutable(env) === null || source === null) return { status: 'missing', evidence: [], missing: ['pi-executable'] };
  return probe({ 'pi-package': piPackagePresent(source, env) ? [source] : [] });
}

function probeOwners(plugins: readonly PluginId[], env: NodeJS.ProcessEnv): Partial<Record<SurfaceOwner, OwnerProbe>> {
  const home = env.HOME ?? homedir();
  const catalog = loadSkillSurfaceCatalog();
  const hosts = selectedSkillHosts(plugins);
  const probes: Partial<Record<SurfaceOwner, OwnerProbe>> = { core: probeCore(env, catalog, hosts) };
  for (const id of plugins) {
    if (isCommandPlugin(id)) continue;
    if (id === 'pi') probes.pi = probePi(env);
    else probes[id] = probe({ skills: completeHostSkillSetEvidence(home, hosts, ownedProbeSkills(catalog, id), env) });
  }
  return probes;
}

export function installStateStatus(
  state: InstallState,
  env: NodeJS.ProcessEnv = process.env,
  records: PathRecords = readPathRecords(env),
): InstallStateStatus {
  const probes = probeOwners(enabledPlugins(state), env);
  const missing = (Object.entries(probes) as [SurfaceOwner, OwnerProbe][])
    .filter(([, result]) => result.status === 'missing')
    .map(([owner]) => owner);
  // A valid selection may consume a pre-existing user-managed CLI, skill, or
  // CodeGraph installation. Ownership is required before removal, not before
  // truthful presence can be reported.
  const ownership = Object.entries(records).map(([path, record]): OwnershipEntry => ({
    path, owner: record.owner, host: record.host, kind: record.kind, type: record.committed.type, current: pathRecordIsCurrent(path, record),
  }));
  const piDrift = piExecutable(env) === null ? [] : state.pi_packages.filter((source) => {
    try { return !piPackagePresent(source, env); } catch { return true; }
  });
  // A file that the user keeps is not rh's to keep current.
  const surfaceDrift = [...ownership.filter((entry) => entry.kind === 'created' && !entry.current).map((entry) => entry.path), ...piDrift];
  return {
    ...state,
    ownership,
    ...skippedOwnership(env),
    probes,
    drift: {
      status: missing.length === 0 && surfaceDrift.length === 0 ? 'consistent' : 'drift',
      missing_owners: missing,
      surface_drift: surfaceDrift,
    },
  };
}

/** Why a host plugin cannot be selected now, or null when its host program is present. Other read errors throw. */
function hostPluginAbsence(_id: (typeof HOST_PROGRAM_PLUGINS)[number], env: NodeJS.ProcessEnv): string | null {
  return piExecutable(env) === null ? 'pi is not on PATH' : null;
}

type InstallTarget = 'claude' | 'codex' | 'both';

const TARGET_HOSTS: Readonly<Record<InstallTarget, readonly SkillHost[]>> = { claude: ['claude'], codex: ['codex'], both: ['claude', 'codex', 'pi'] };
const TARGET_BOTH_COMMAND = 'rh install --target both';

/**
 * Why this target cannot run a plugin now, and the command that adds it, or
 * null. A command plugin is always available. A skill plugin needs a target
 * host for one of its skills. The Pi plugin needs the Pi host, and a host
 * plugin needs its program. A read error other than a definite absence throws.
 */
function pluginUnavailable(id: PluginId, target: InstallTarget, env: NodeJS.ProcessEnv): { readonly reason: string; readonly command: string } | null {
  if (isCommandPlugin(id)) return null;
  if (id === 'pi' && target !== 'both') return { reason: `--target ${target} does not include the Pi host`, command: TARGET_BOTH_COMMAND };
  const skills = ownedProbeSkills(loadSkillSurfaceCatalog(), id);
  if (skills.length > 0 && !skills.some(pkg => pkg.hosts.some(host => (TARGET_HOSTS[target] as readonly string[]).includes(host)))) {
    return { reason: `--target ${target} has no host for its skills`, command: TARGET_BOTH_COMMAND };
  }
  const absence = isHostProgramPlugin(id) ? hostPluginAbsence(id, env) : null;
  return absence === null ? null : { reason: absence, command: UPDATE_COMMAND };
}

/** An explicit plugin fails closed before any write when its host program or a host of its skills is absent. */
export function assertExplicitSelectionRunnable(plugins: readonly PluginId[], target: InstallTarget, env: NodeJS.ProcessEnv = process.env): void {
  const unavailable = plugins.flatMap((id) => {
    const absent = pluginUnavailable(id, target, env);
    return absent === null ? [] : [`${id} (${absent.reason})`];
  });
  if (unavailable.length > 0) {
    throw new InstallStateError('install_plugin_unavailable', installProfileStatePath(env),
      `cannot select ${unavailable.join(', ')}; install the host program or choose a target with its host, or drop the plugin from --plugins`);
  }
}

/**
 * The one resolver of a selection on this host, for install, update and the
 * candidate process. An explicit list runs and records exactly its ids or
 * fails closed. `all` runs and records every plugin of this version; a host
 * plugin whose program or target is absent is skipped, or kept in the record
 * when the state already records it (removal needs an explicit selection).
 */
export function resolveRecordedSelection(
  state: Pick<InstallState, 'selection' | 'plugins'>,
  target: InstallTarget,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly partial?: boolean } = {},
): SelectionResolution {
  if (state.selection !== 'all') {
    assertExplicitSelectionRunnable(state.selection, target, env);
    return { run: state.selection, record: state.selection, skipped: [], kept: [], notAdded: [] };
  }
  const recorded = enabledPlugins(state);
  const run: PluginId[] = [];
  const keptReasons = new Map<PluginId, string>();
  const skipped: SkippedPlugin[] = [];
  for (const id of PLUGIN_IDS) {
    const absent = pluginUnavailable(id, target, env);
    if (absent === null) run.push(id);
    else if (recorded.includes(id)) keptReasons.set(id, absent.reason);
    else skipped.push({ id, ...absent });
  }
  const grown = PLUGIN_IDS.filter(id => run.includes(id) || keptReasons.has(id));
  // A partial refresh (--no-sync-skill or --no-hooks) runs and records only the recorded set.
  const record = options.partial === true ? grown.filter(id => recorded.includes(id)) : grown;
  const kept = [...keptReasons].map(([id, reason]) => ({ id, reason, command: installSelectionCommand(record.filter(other => other !== id)) }));
  return {
    run: run.filter(id => record.includes(id)), record, skipped, kept,
    notAdded: grown.filter(id => !record.includes(id)),
  };
}

/** A fresh `all` selection: every plugin that the host can run. */
export function defaultPluginSelection(target: InstallTarget, env: NodeJS.ProcessEnv = process.env): { readonly plugins: readonly PluginId[]; readonly skipped: readonly SkippedPlugin[] } {
  const { run, skipped } = resolveRecordedSelection({ selection: 'all', plugins: [] }, target, env);
  return { plugins: run, skipped };
}

export function skippedPluginLine(entry: SkippedPlugin): string {
  const after = entry.command === UPDATE_COMMAND ? 'install the host program, then run' : 'run';
  return `skipped ${entry.id}: ${entry.reason}; to add it later, ${after}: ${entry.command}`;
}

export function keptPluginLine(entry: KeptPlugin): string {
  return `kept ${entry.id}: ${entry.reason}; update keeps the recorded plugin; to remove it, run: ${entry.command}`;
}

export function notAddedPluginLine(id: PluginId): string {
  return `not added ${id} in a partial refresh; run: ${UPDATE_COMMAND}`;
}

/** The O3 repair of an explicit list: one command for every unselected command plugin, because a second command would drop the first id. */
export function commandPluginRepairLines(selection: PluginSelection): string[] {
  if (selection === 'all') return [];
  const missing = COMMAND_PLUGINS.filter(id => !selection.includes(id));
  if (missing.length === 0) return [];
  const repair = installSelectionCommand(PLUGIN_IDS.filter(id => selection.includes(id) || isCommandPlugin(id)));
  return [`[plugins] not selected ${missing.join(', ')}: an explicit list does not grow; to add them, run: ${repair}`];
}

/**
 * A repository whose policy sets `context.capability_source: archcontext` or
 * `tooling.codegraph.enabled: true` needs the architecture plugin. update,
 * install and init stop here before any write when the selection lacks it.
 */
export function assertArchitecturePolicySelection(cwd: string, plugins: readonly PluginId[], env: NodeJS.ProcessEnv = process.env): void {
  if (plugins.includes('architecture')) return;
  const policy = readWorkflowPolicyDocument(cwd);
  if (!policy.present) return;
  // A non-object section on the path leaves the key absent.
  const tooling = policy.rootIsObject ? policyValue(policy, 'tooling') : POLICY_ABSENT;
  const codegraph = isPolicyObject(tooling) ? policyValue(policy, 'tooling.codegraph') : POLICY_ABSENT;
  const codegraphEnabled = isPolicyObject(codegraph) ? policyValue(policy, 'tooling.codegraph.enabled') : POLICY_ABSENT;
  const needs = [
    ...(capabilitySourceModeOf(policy) === 'archcontext' ? ['context.capability_source: archcontext'] : []),
    ...(codegraphEnabled === true ? ['tooling.codegraph.enabled: true'] : []),
  ];
  if (needs.length === 0) return;
  throw new InstallStateError('install_plugin_unavailable', installProfileStatePath(env),
    `${join(cwd, POLICY_PATH)} sets ${needs.join(' and ')}, which needs the architecture plugin; run: ${pluginRepair('architecture', plugins)}`);
}

/** `run` drives the Pi package and skill projections; `record` is the plugin set that the plan installs, keeps and removes. */
export function planInstallSelection(
  selection: PluginSelection,
  resolved: Pick<SelectionResolution, 'run' | 'record'> & { readonly skipped?: readonly SkippedPlugin[] },
  current: InstallState | null,
  env: NodeJS.ProcessEnv = process.env,
): InstallPlan {
  const packageRoot = bunGlobalPackageRoot(env);
  if (packageRoot === null) throw new Error('Bun global package root unavailable: set HOME, USERPROFILE or BUN_INSTALL');
  const installed = current === null ? [] : enabledPlugins(current);
  const plugins = resolved.record;
  return {
    hosts: INSTALL_HOSTS,
    pi_package: planPiPackage(packageRoot, resolved.run.includes('pi'), env),
    skill_projections: expectedSkillProjections(loadSkillSurfaceCatalog(), packageRoot, env.HOME ?? env.USERPROFILE ?? homedir(), resolved.run, env),
    protocol: INSTALL_STATE_PROTOCOL,
    selection,
    requested_plugins: plugins,
    current_plugins: current === null ? null : installed,
    install: plugins.filter((id) => !installed.includes(id)),
    keep: plugins.filter((id) => installed.includes(id)),
    remove: installed.filter((id) => !plugins.includes(id)),
    skipped: resolved.skipped ?? [],
    state_path: installProfileStatePath(env),
  };
}

export function writeState(state: InstallState, env: NodeJS.ProcessEnv): void {
  const target = installProfileStatePath(env);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  retryWindowsSharingRace(() => renameSync(temp, target));
}

/** Core and enabled plugins record the running CLI version. */
export function versions(plugins: readonly PluginId[]): Pick<InstallState, 'core' | 'plugins'> {
  return { core: { version: PACKAGE_VERSION }, plugins: plugins.map(id => ({ id, version: PACKAGE_VERSION })) };
}

function snapshot(state: InstallState): InstallStateSnapshot {
  const { previous: _previous, ...rest } = state;
  return rest;
}

/**
 * Commit a selection. `plugins` is the recorded set (`record` of the resolver).
 * A `kept` plugin is recorded but did not run: its ledger surfaces stay as
 * they are, and neither its probe nor its surfaces gate this commit.
 */
export function applyInstallSelection(
  selection: PluginSelection,
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  transaction?: HostSurfaceSnapshots,
  options: {
    readonly agentFleetVerified?: boolean;
    readonly additionalPiPackages?: readonly string[];
    readonly kept?: readonly PluginId[];
  } = {},
): { readonly plan: InstallPlan; readonly state: InstallState } {
  if (selection !== 'all' && selection.join(',') !== plugins.join(',')) {
    throw new Error(`explicit selection ${selection.join(',')} does not equal the recorded plugins ${plugins.join(',')}`);
  }
  const kept = options.kept ?? [];
  const ran = plugins.filter(id => !kept.includes(id));
  const current = readInstallState(env);
  const additionalPi = options.additionalPiPackages ?? [];
  if (additionalPi.some(source => !validPiPackage(source, env, plugins))) throw new Error('invalid Pi package ownership');
  const plan = planInstallSelection(selection, { run: ran, record: plugins }, current, env);
  const { records: prior, outside, unsupported } = readPathRecordSet(env);
  const discovered = discoverManagedSurfaces(ran, env);
  const records = carriedRecords(prior, kept);
  const transactionOwned = transaction ? transactionOwnedSurfaces(transaction, prior, env) : { captures: [], absent: new Set<string>() };
  const fleetOwned = options.agentFleetVerified === true ? verifiedAgentFleetSurfaces(env, prior) : [];
  // Current verified link projections own their classification. Historical
  // records must not restore a retired owner.
  for (const surface of [...discovered, ...transactionOwned.captures, ...fleetOwned, ...discovered.filter(surface => surface.committed.type === 'symlink')]) {
    recordCapture(env, records, surface, prior, transactionOwned.absent);
  }
  const committed = selectionRecords(records, plugins);
  const piPackages = [...new Set([...(current?.pi_packages ?? []), ...additionalPi])].filter(source => validPiPackage(source, env, plugins));
  const recordedVersions = versions(plugins);
  const unchanged = current !== null
    && JSON.stringify({ core: current.core, plugins: current.plugins }) === JSON.stringify(recordedVersions)
    && JSON.stringify(current.selection) === JSON.stringify(selection)
    && JSON.stringify(current.pi_packages) === JSON.stringify(piPackages)
    && pathRecordsDigest(prior) === pathRecordsDigest(committed)
    // A record outside its host root goes with the next write, so it never stays unacted forever.
    && outside.length === 0 && unsupported.length === 0;
  const state: InstallState = {
    protocol: INSTALL_STATE_PROTOCOL,
    ...recordedVersions,
    selection,
    transaction_id: randomUUID(),
    applied_at: now.toISOString(),
    pi_packages: piPackages,
    previous: current === null ? null : snapshot(current),
  };
  const status = installStateStatus({ ...state, plugins: state.plugins.filter(plugin => !kept.includes(plugin.id)) }, env,
    Object.fromEntries(Object.entries(committed).filter(([, record]) => !(kept as readonly string[]).includes(record.owner))));
  if (status.drift.status !== 'consistent') {
    throw new Error(
      `install projection is incomplete: missing=${status.drift.missing_owners.map(owner => `${owner}(${status.probes[owner]?.missing.join('+')})`).join(',') || '(none)'}; surface_drift=${status.drift.surface_drift.join(',') || '(none)'}`,
    );
  }
  // A no-change apply writes nothing, so `previous` keeps the last real change for a rollback.
  if (unchanged) return { plan, state: current };
  writePathRecords(env, committed);
  writeState(state, env);
  return { plan, state };
}

export function rollbackInstallSelection(
  env: NodeJS.ProcessEnv = process.env,
  transaction?: InstallHostTransaction,
): InstallState {
  const current = readInstallState(env);
  if (!current?.previous) throw new Error('no previous install transaction to roll back');
  const plugins = enabledPlugins(current.previous);
  const prior = readPathRecords(env);
  const records = carriedRecords(prior);
  const transactionOwned = transaction ? transactionOwnedSurfaces(transaction, prior, env) : { captures: [], absent: new Set<string>() };
  for (const surface of [...discoverManagedSurfaces(plugins, env), ...transactionOwned.captures]) recordCapture(env, records, surface, prior, transactionOwned.absent);
  const committed = selectionRecords(records, plugins);
  const restored: InstallState = {
    ...current.previous,
    ...versions(plugins),
    transaction_id: randomUUID(),
    applied_at: new Date().toISOString(),
    pi_packages: current.pi_packages.filter(source => validPiPackage(source, env, plugins)),
    previous: null,
  };
  const status = installStateStatus(restored, env, committed);
  if (status.drift.status !== 'consistent') {
    throw new Error(
      `rollback projection is incomplete: missing=${status.drift.missing_owners.map(owner => `${owner}(${status.probes[owner]?.missing.join('+')})`).join(',') || '(none)'}; surface_drift=${status.drift.surface_drift.join(',') || '(none)'}`,
    );
  }
  writePathRecords(env, committed);
  writeState(restored, env);
  return restored;
}
