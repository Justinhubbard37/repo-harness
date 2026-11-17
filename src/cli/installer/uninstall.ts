import { globalConfigurationPath, mutateGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../../effects/locking/runtime-transaction-lock';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { stagedSkillRoot, hostSkillRoot, providerSkillLock, type ProviderSkillLock } from '../../effects/host-skill-roots';
import { piPackagePresent, removePiPackage } from './pi-package';
import { piExecutable } from '../../effects/pi-executable';
import { globalContextPath, inspectUnrecordedGlobalRules, previewGlobalRulesAdoptedRevert } from './global-context';
import { removeRuntimeStateIgnoreBlock } from '../../effects/adoption/gitignore-plan';
import { readRepositoryExcludes, repositoryCommonDirectory, repositoryExcludesLedgerPath, repositoryExcludeTarget, serializeRepositoryExcludes, type RepositoryExclude } from './repository-excludes';
import { readInstallState } from './install-profile';
import { installStatePendingMigration, migrateInstallState, planInstallStateMigration } from './install-state-migration';
import type { PathRecord } from '../../core/host-config/types';
import { pathRecordsDigest, readPathRecords, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import { installProfileStatePath } from './install-state';
import { assertConfigurationPath, configurationReceiptPath, hostConfigurationRoot, writePrivateConfiguration } from './configuration-ownership';
import { migrateCodexConfigRecords, planCodexConfigMigration, previewAdoptedRevert } from './codex-config-migration';
import { migrateJsonConfigRecords, planJsonConfigMigration, previewJsonAdoptedRevert } from './json-config-migration';
import { openHostConfigGate, planPathRevert, type HostConfigAdoption, type HostConfigRevertEntry } from '../../effects/host-config/gate';
import { hostConfigPaths, resolveHostPath } from '../../effects/host-config/store';

export interface UninstallOptions { target: 'codex' | 'claude' | 'both'; dryRun?: boolean; env?: NodeJS.ProcessEnv; runtimeLock?: RuntimeTransactionContext }
export interface UninstallItem { path: string; action: 'remove' | 'restore' | 'preserve' | 'unresolved' | 'note'; reason: string }
export interface UninstallResult { exitCode: number; status: 'complete' | 'partial'; dryRun: boolean; items: UninstallItem[]; lines: string[] }

/** The running CLI's package root: its rules template proves which global rules block install wrote. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function selected(path: string, target: UninstallOptions['target'], home: string): boolean {
  if (target === 'both') return true;
  return path.startsWith(join(home, `.${target}`) + '/') || (target === 'claude' && path === join(home, '.claude.json'));
}
function fileExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function fingerprint(path: string): string | null {
  if (!fileExists(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isDirectory()) return `dir:${readdirSync(path).sort().map((name) => `${name}:${fingerprint(join(path, name))}`).join('|')}`;
  if (!stat.isFile()) throw new Error(`unsupported installed surface: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function object(raw: string): Record<string, any> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected JSON object');
  return parsed;
}

/** Plan completely before writing; dry-run neither takes a filesystem lock nor creates receipts. */
export function runUserUninstall(opts: UninstallOptions): UninstallResult {
  if (opts.dryRun) return runUserUninstallLocked(opts);
  // Reject invalid authority without creating a lock directory. Read it again
  // under the lock before planning any mutation, since another writer can run here.
  // A protocol 3 state is read after its migration under the lock.
  try { if (!installStatePendingMigration(opts.env ?? process.env)) readUninstallState(opts); }
  catch (error) {
    return uninstallResult([{ path: configurationReceiptPath(hostConfigurationRoot(opts.env)), action: 'unresolved', reason: String((error as Error).message) }], false);
  }
  return withRuntimeTransactionContext(globalRuntimeScope(opts.env), opts.runtimeLock, (runtimeLock) => runUserUninstallLocked({ ...opts, runtimeLock }));
}

/** The host files that the host-config ledger owns, by uninstall target. */
function hostConfigFiles(home: string, target: UninstallOptions['target']): { codex: string | null; json: string[] } {
  const codex = join(home, '.codex/config.toml');
  const json = [join(home, '.codex/hooks.json'), join(home, '.claude/settings.json'), join(home, '.claude.json')];
  return { codex: selected(codex, target, home) ? codex : null, json: json.filter((path) => selected(path, target, home)) };
}

/**
 * Before the migrations run (a dry run, or the check before the lock), they
 * are planned in memory. A target leaves the files of the other host and their
 * old records as they are, also when a migration would reject such a file.
 */
function readUninstallState(opts: UninstallOptions) {
  const env = opts.env ?? process.env;
  const home = hostConfigurationRoot(env);
  assertConfigurationPath(installProfileStatePath(env), home);
  const lock = providerSkillLock(home, env);
  const files = hostConfigFiles(home, opts.target);
  const codexMigration = files.codex ? planCodexConfigMigration(env) : null;
  const jsonMigration = files.json.length ? planJsonConfigMigration(env, files.json) : null;
  // A dry run on a protocol 3 state plans with the migration's projection and writes nothing.
  const projected = opts.dryRun && installStatePendingMigration(env) ? planInstallStateMigration(env) : null;
  const state = projected?.state ?? readInstallState(env);
  const records = projected ? projected.records : state ? readPathRecords(env) : {};
  return { state, records, lock, files, codexMigration, jsonMigration };
}

const REVERT_ITEMS: Readonly<Record<Exclude<HostConfigRevertEntry['action'], 'released'>, Pick<UninstallItem, 'action' | 'reason'>>> = {
  removed: { action: 'remove', reason: 'host-config ledger: rh created this file' },
  restored: { action: 'restore', reason: 'host-config ledger: the file before rh' },
  text_removed: { action: 'restore', reason: 'host-config ledger: rh text removed' },
  kept_edited: { action: 'unresolved', reason: 'changed since rh wrote it; preserved' },
};

function revertItem(entry: HostConfigRevertEntry): UninstallItem {
  const item = REVERT_ITEMS[entry.action as keyof typeof REVERT_ITEMS];
  return { path: entry.path, action: item.action, reason: entry.kept?.length ? `${item.reason}: ${entry.kept.join(', ')}` : item.reason };
}

function sameRevert(left: readonly HostConfigRevertEntry[], right: readonly HostConfigRevertEntry[]): boolean {
  const key = (entries: readonly HostConfigRevertEntry[]) => entries.map((entry) => `${entry.action}:${entry.kept?.join(',') ?? ''}`).join();
  return key(left) === key(right);
}

function uninstallResult(items: UninstallItem[], dryRun: boolean): UninstallResult {
  const partial = items.some((item) => item.action === 'unresolved');
  return { exitCode: partial ? 1 : 0, status: partial ? 'partial' : 'complete', dryRun, items,
    lines: [...items.map((item) => `[${item.action}] ${item.path}: ${item.reason}`), `[uninstall] ${partial ? 'partial' : 'complete'}${dryRun ? ' (dry-run)' : ''}`] };
}

function runUserUninstallLocked(opts: UninstallOptions): UninstallResult {
  const env = opts.env ?? process.env;
  const home = hostConfigurationRoot(env);
  const items: UninstallItem[] = [];
  const writes = new Map<string, string | null>();
  const originals = new Map<string, string | null>();
  const surfaceRemovals: string[] = [];
  const piRemovals: string[] = [];
  const piSkills = hostSkillRoot(home, 'pi', env);
  let lock: ProviderSkillLock;
  // A repository exclude file, its links followed, has its own directory as its root.
  const repositoryExcludes = new Set<string>();
  // A path record's key has its parent links followed, so it is checked under the root with links followed.
  const recordRoots = new Map<string, string>();
  const surfaceRoot = (path: string) => recordRoots.get(path) ?? (path === lock.path ? lock.root : repositoryExcludes.has(path) ? dirname(path) : path.startsWith(piSkills + '/') ? dirname(piSkills) : home);
  const removedSurfaces = new Set<string>();
  // The gate's dry-run revert of each path record in removedSurfaces; the apply must match it.
  const pathReverts = new Map<string, HostConfigRevertEntry>();
  const removedPi = new Set<string>();
  const remember = (path: string): void => { if (!originals.has(path)) originals.set(path, fingerprint(path)); };
  const read = (path: string): string => writes.has(path) ? writes.get(path) ?? '' : existsSync(path) ? readFileSync(path, 'utf8') : '';
  const change = (path: string, value: string | null, reason: string, action: 'remove' | 'restore' = 'remove'): void => {
    remember(path); writes.set(path, value); items.push({ path, action, reason });
  };
  const unresolved = (path: string, reason: string): void => { items.push({ path, action: 'unresolved', reason }); };
  let state: ReturnType<typeof readInstallState> = null;
  let records: PathRecords = {};
  let files: ReturnType<typeof hostConfigFiles>;
  let codexMigration: ReturnType<typeof planCodexConfigMigration>;
  let jsonMigration: ReturnType<typeof planJsonConfigMigration>;
  try {
    if (!opts.dryRun) migrateInstallState(env);
    const targets = hostConfigFiles(home, opts.target);
    if (!opts.dryRun && targets.codex) migrateCodexConfigRecords(env);
    if (!opts.dryRun && targets.json.length) migrateJsonConfigRecords(env, targets.json);
    ({ state, records, lock, files, codexMigration, jsonMigration } = readUninstallState(opts));
  } catch (error) { unresolved(configurationReceiptPath(home), String((error as Error).message)); return result(); }

  const gate = openHostConfigGate({ env });
  const hostPaths = [...(files.codex ? [files.codex] : []), ...files.json];
  // The Global Working Rules files go by the ledger too. Two host paths that name one file are one revert.
  const rulesAdoptions = new Map<string, HostConfigAdoption>();
  const resolvedHostPaths = new Set<string>();
  for (const host of ['codex', 'claude'] as const) {
    if (opts.target !== 'both' && opts.target !== host) continue;
    const contextPath = globalContextPath(home, host);
    try {
      const resolved = resolveHostPath(hostConfigPaths(env), contextPath);
      if (resolvedHostPaths.has(resolved)) continue;
      resolvedHostPaths.add(resolved);
      if (!gate.recorded(contextPath).length) {
        const unrecorded = inspectUnrecordedGlobalRules(contextPath, SOURCE_ROOT);
        if (unrecorded.kind === 'none') continue;
        if (unrecorded.kind === 'preserved') { unresolved(contextPath, unrecorded.reason); continue; }
        // The one-shot migration: a dry run plans it in memory.
        if (opts.dryRun) rulesAdoptions.set(contextPath, unrecorded.adoption);
        else gate.adopt(contextPath, unrecorded.adoption);
      }
      hostPaths.push(contextPath);
    } catch (error) { unresolved(contextPath, String((error as Error).message)); }
  }
  const previewOf = (path: string): readonly HostConfigRevertEntry[] => {
    const rules = rulesAdoptions.get(path);
    if (rules) return [previewGlobalRulesAdoptedRevert(path, rules)];
    if (path === files.codex && codexMigration?.adoption) return previewAdoptedRevert(codexMigration);
    const planned = jsonMigration?.files.find((file) => file.path === path);
    return planned ? previewJsonAdoptedRevert({ ...jsonMigration!, files: [planned] }) : gate.revert([path], { dryRun: true });
  };
  let hostRevert: readonly HostConfigRevertEntry[] = [];
  for (const path of hostPaths) {
    try {
      const preview = previewOf(path);
      hostRevert = [...hostRevert, ...preview];
      for (const entry of preview) if (entry.action !== 'released') items.push(revertItem(entry));
    } catch (error) { unresolved(path, String((error as Error).message)); }
  }
  if (files.codex && existsSync(files.codex)) {
    try {
      const parsed = Bun.TOML.parse(readFileSync(files.codex, 'utf8')) as Record<string, any>;
      // Codex writes these after the user trusts the hooks; they never block completion.
      if (parsed.hooks?.state && Object.keys(parsed.hooks.state).length) items.push({ path: files.codex, action: 'note', reason: 'Codex keeps its hook trust entries in [hooks.state]; rh does not remove them.' });
    } catch (error) { unresolved(files.codex, String((error as Error).message)); }
  }

  for (const source of opts.target === 'both' ? state?.pi_packages ?? [] : []) {
    try {
      if (piExecutable(env) === null) {
        items.push({ path: source, action: 'preserve', reason: 'pi not found on PATH; package removal skipped; ownership retained for retry' });
        continue;
      }
      if (piPackagePresent(source, env)) {
        piRemovals.push(source);
        items.push({ path: source, action: 'remove', reason: 'transaction-owned Pi package entry through pi remove' });
      }
      removedPi.add(source);
    } catch (error) { unresolved(source, (error as Error).message); }
  }
  const realRoot = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  for (const [key, record] of Object.entries(records) as [string, PathRecord][]) {
    // The host comes from the path as the install named it, so a linked ~/.claude still is `claude`.
    if (opts.target !== 'both' && record.host !== opts.target) continue;
    // The user keeps the file; the uninstall only releases the record.
    if (record.kind === 'user_managed') {
      if (opts.target === 'both') { removedSurfaces.add(key); pathReverts.set(key, { path: key, action: 'released' }); }
      continue;
    }
    if (record.host === 'bin') {
      items.push({ path: key, action: 'preserve', reason: 'package-manager installation retained; remove separately after configuration cleanup' });
      continue;
    }
    try {
      recordRoots.set(key, realRoot(record.host === 'pi' ? dirname(piSkills) : home));
      // A record may own the final symlink, but never a symlinked parent directory.
      assertConfigurationPath(dirname(key), surfaceRoot(key));
      // The records of a dry-run migration are not in the ledger yet, so the plan reads them from `records`.
      const action = planPathRevert(key, record);
      if (action === 'kept_edited') { unresolved(key, 'owned surface changed since installation; preserved'); continue; }
      pathReverts.set(key, { path: key, action });
      removedSurfaces.add(key);
      if (action === 'released') continue;
      remember(key); surfaceRemovals.push(key);
      items.push(action === 'restored'
        ? { path: key, action: 'restore', reason: 'unchanged transaction-owned file; the user file it replaced comes back from the vault' }
        : { path: key, action: 'remove', reason: 'unchanged transaction-owned surface' });
    } catch (error) { unresolved(key, String((error as Error).message)); }
  }

  if (opts.target === 'both') {
    const path = join(home, '.repo-harness/config.json');
    try {
      assertConfigurationPath(path, home);
      if (existsSync(path)) {
        const data = object(read(path));
        if ('protectedHelperRuntime' in data || 'architecture' in data || 'refactor_recommendations' in data) {
          delete data.protectedHelperRuntime; delete data.architecture; delete data.refactor_recommendations;
          change(path, Object.keys(data).length ? `${JSON.stringify(data, null, 2)}\n` : null, 'rh helper/architecture configuration; data directories retained');
        }
      }
    } catch (error) { unresolved(path, String((error as Error).message)); }
    const ledgerPath = repositoryExcludesLedgerPath(env);
    let ledger: RepositoryExclude[] = [];
    try { ledger = readRepositoryExcludes(env); } catch (error) { unresolved(ledgerPath, String((error as Error).message)); }
    const retained = ledger.filter((entry) => {
      try {
        if (!existsSync(entry.repo_path)) throw new Error(`repository ${entry.repo_path} is unavailable; block and ledger entry kept`);
        const path = repositoryExcludeTarget(repositoryCommonDirectory(entry.repo_path, env), env);
        if (path !== entry.exclude_path) throw new Error(`repository ${entry.repo_path} now resolves its exclude file to ${path}; preserved`);
        repositoryExcludes.add(path);
        // Read as latin1 and written back the same way, so the bytes outside the block stay.
        const removal = removeRuntimeStateIgnoreBlock(existsSync(path) ? readFileSync(path, 'latin1') : '');
        if (removal.status === 'unbalanced') unresolved(path, 'unbalanced runtime-state ignore block; preserved');
        else if (removal.status === 'edited') unresolved(path, 'runtime-state ignore block was edited; preserved. Move your rules outside the markers, then delete the block.');
        else if (removal.status === 'removed') change(path, removal.content, 'runtime-state ignore block');
        return removal.status === 'unbalanced' || removal.status === 'edited';
      } catch (error) { unresolved(entry.exclude_path, String((error as Error).message)); return true; }
    });
    if (retained.length !== ledger.length) change(ledgerPath, serializeRepositoryExcludes(retained), 'repository excludes ledger');
  }

  // Only remove lock entries for staging skills actually removed in this operation.
  const staging = surfaceRemovals.filter((key) => records[key]!.host === 'staged' && basename(dirname(key)) === basename(stagedSkillRoot(home)));
  if (staging.length && existsSync(lock.path)) {
    try {
      assertConfigurationPath(lock.path, lock.root);
      const data = object(read(lock.path));
      if (!data.skills || typeof data.skills !== 'object' || Array.isArray(data.skills)) throw new Error('invalid skills lock; preserved');
      for (const key of staging) delete data.skills[basename(key)];
      change(lock.path, `${JSON.stringify(data, null, 2)}\n`, 'removed staging skill registrations');
    } catch (error) {
      unresolved(lock.path, String((error as Error).message));
      // A retry selects lock entries from staging ownership, so keep both.
      for (const key of staging) {
        surfaceRemovals.splice(surfaceRemovals.indexOf(key), 1);
        removedSurfaces.delete(key);
        Object.assign(items.find((item) => item.path === key && item.action === 'remove')!, { action: 'preserve', reason: 'staging skill retained until its lock entry can be removed' });
      }
    }
  }

  const statePath = installProfileStatePath(env);
  // A retired state drops every path record that the gate revert leaves (the preserved `bin` entries); a partial run keeps them for a retry or the other host.
  let retireRecords = false;
  const recordsDigest = pathRecordsDigest(records);
  if (state) {
    const pendingPi = state.pi_packages.filter((source) => !removedPi.has(source));
    if (opts.target === 'both' && !pendingPi.length && !items.some((item) => item.action === 'unresolved')) {
      change(statePath, null, 'install state retired');
      retireRecords = true;
    } else if (removedPi.size) {
      change(statePath, `${JSON.stringify({ ...state, pi_packages: pendingPi, previous: null }, null, 2)}\n`, 'retain remaining ownership for retry/other host');
    }
  }
  items.push({ path: join(home, '.repo-harness'), action: 'preserve', reason: 'archives, runtime history and the MCP config retained; third-party packages/plugins retained' });

  if (!opts.dryRun) {
    try {
      for (const [path, expected] of originals) {
        assertConfigurationPath(dirname(path), surfaceRoot(path));
        if (fingerprint(path) !== expected) throw new Error(`configuration changed after preview: ${path}`);
      }
      // A retry selects lock entries from staging ownership, so the lock
      // cleanup lands before the staging removal and the ledger write.
      const lockCleanup = writes.get(lock.path);
      if (typeof lockCleanup === 'string') { writePrivateConfiguration(lock.path, lockCleanup, lock.root); writes.delete(lock.path); }
      // A failed Pi readback stops before the ownership ledger is written.
      for (const source of piRemovals) removePiPackage(source, env);
      const surfaces = [...removedSurfaces];
      if ((surfaces.length || retireRecords) && pathRecordsDigest(readPathRecords(env)) !== recordsDigest) throw new Error(`configuration changed after preview: ${hostConfigPaths(env).ledger}`);
      // The gate undoes each entry and then drops its record, so a stop between them leaves a record of a missing path, which a retry releases.
      if (surfaces.length && !sameRevert(gate.revertPaths(surfaces), surfaces.map((key) => pathReverts.get(key)!))) throw new Error(`configuration changed after preview: ${surfaces.join(', ')}`);
      if (retireRecords) writePathRecords(env, {});
      for (const [path, content] of writes) {
        assertConfigurationPath(path, surfaceRoot(path));
        if (path === globalConfigurationPath(env)) {
          mutateGlobalConfiguration(env, () => ({ config: content === null ? null : object(content), value: undefined }), { runtimeLock: opts.runtimeLock });
        } else if (content === null) { if (existsSync(path)) unlinkSync(path); }
        else if (repositoryExcludes.has(path)) writeFileSync(path, content, 'latin1');
        else writePrivateConfiguration(path, content, surfaceRoot(path));
      }
      if (hostPaths.length && !sameRevert(gate.revert(hostPaths), hostRevert)) throw new Error(`configuration changed after preview: ${hostPaths.join(', ')}`);
      for (const path of [...originals.keys()]) {
        const parent = dirname(path);
        // Never remove a host root or history tree; only now-empty managed leaf containers.
        if (['skills', 'rules', 'agents'].includes(parent.split('/').at(-1) ?? '') && existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
      }
    } catch (error) { unresolved(home, `uninstall incomplete: ${String((error as Error).message)}`); }
  }
  return result();
  function result(): UninstallResult { return uninstallResult(items, opts.dryRun === true); }
}
