import { globalConfigurationPath, mutateGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../../effects/locking/runtime-transaction-lock';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { MANAGED_TAG } from '../../core/adoption/managed-hook-config';
import { stagedSkillRoot, hostSkillRoot, providerSkillLock, type ProviderSkillLock } from '../../effects/host-skill-roots';
import { piPackagePresent, removePiPackage } from './pi-package';
import { piExecutable } from '../../effects/pi-executable';
import { globalContextPath, removeManagedBlock } from './global-context';
import { removeRuntimeStateIgnoreBlock } from '../../effects/adoption/gitignore-plan';
import { readRepositoryExcludes, repositoryCommonDirectory, repositoryExcludesLedgerPath, repositoryExcludeTarget, serializeRepositoryExcludes, type RepositoryExclude } from './repository-excludes';
import { CODEGRAPH_CONFIG_MARKER, managedInstallSurfaceIsCurrent, readInstallState, type ManagedInstallSurface } from './install-profile';
import { installProfileStatePath } from './install-state';
import { assertConfigurationPath, configurationReceiptPath, hostConfigurationRoot, writePrivateConfiguration } from './configuration-ownership';
import { migrateCodexConfigRecords, planCodexConfigMigration, previewAdoptedRevert } from './codex-config-migration';
import { migrateJsonConfigRecords, planJsonConfigMigration, previewJsonAdoptedRevert } from './json-config-migration';
import { openHostConfigGate, type HostConfigRevertEntry } from '../../effects/host-config/gate';

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
  try { readUninstallState(opts); }
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
  return { state: readInstallState(env), lock, files, codexMigration, jsonMigration };
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
  const surfaceRemovals: ManagedInstallSurface[] = [];
  const piRemovals: string[] = [];
  const piSkills = hostSkillRoot(home, 'pi', env);
  let lock: ProviderSkillLock;
  // A repository exclude file, its links followed, has its own directory as its root.
  const repositoryExcludes = new Set<string>();
  const surfaceRoot = (path: string) => path === lock.path ? lock.root : repositoryExcludes.has(path) ? dirname(path) : path.startsWith(piSkills + '/') ? dirname(piSkills) : home;
  const removedSurfaces = new Set<ManagedInstallSurface>();
  const remember = (path: string): void => { if (!originals.has(path)) originals.set(path, fingerprint(path)); };
  const read = (path: string): string => writes.has(path) ? writes.get(path) ?? '' : existsSync(path) ? readFileSync(path, 'utf8') : '';
  const change = (path: string, value: string | null, reason: string, action: 'remove' | 'restore' = 'remove'): void => {
    remember(path); writes.set(path, value); items.push({ path, action, reason });
  };
  const unresolved = (path: string, reason: string): void => { items.push({ path, action: 'unresolved', reason }); };
  let state: ReturnType<typeof readInstallState> = null;
  let files: ReturnType<typeof hostConfigFiles>;
  let codexMigration: ReturnType<typeof planCodexConfigMigration>;
  let jsonMigration: ReturnType<typeof planJsonConfigMigration>;
  try {
    const targets = hostConfigFiles(home, opts.target);
    if (!opts.dryRun && targets.codex) migrateCodexConfigRecords(env);
    if (!opts.dryRun && targets.json.length) migrateJsonConfigRecords(env, targets.json);
    ({ state, lock, files, codexMigration, jsonMigration } = readUninstallState(opts));
  } catch (error) { unresolved(configurationReceiptPath(home), String((error as Error).message)); return result(); }

  const gate = openHostConfigGate({ env });
  const hostPaths = [...(files.codex ? [files.codex] : []), ...files.json];
  const previewOf = (path: string): readonly HostConfigRevertEntry[] => {
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

  for (const host of ['codex', 'claude'] as const) {
    if (opts.target !== 'both' && opts.target !== host) continue;
    const contextPath = globalContextPath(home, host);
    try {
      if (!existsSync(contextPath)) continue;
      assertConfigurationPath(contextPath, home);
      const removal = removeManagedBlock(read(contextPath), SOURCE_ROOT);
      if (removal.status === 'none') continue;
      if (removal.status === 'unbalanced') throw new Error('unbalanced managed global rules; preserved');
      if (removal.status === 'edited') throw new Error('managed rules block was edited; preserved. Move your rules outside the markers, then delete the block.');
      change(contextPath, removal.content.trim() ? removal.content : null, 'managed global working rules');
    } catch (error) { unresolved(contextPath, String((error as Error).message)); }
  }

  for (const surface of state?.ownership_manifest ?? []) {
    if (!selected(surface.path, opts.target, home)) continue;
    if (surface.type === 'pi-package') {
      try {
        if (piExecutable(env) === null) {
          items.push({ path: surface.path, action: 'preserve', reason: 'pi not found on PATH; package removal skipped; ownership retained for retry' });
          continue;
        }
        if (piPackagePresent(surface.path, env)) {
          piRemovals.push(surface.path);
          items.push({ path: surface.path, action: 'remove', reason: 'transaction-owned Pi package entry through pi remove' });
        }
        removedSurfaces.add(surface);
      } catch (error) { unresolved(surface.path, (error as Error).message); }
      continue;
    }
    // A section record of a host file is the migration's: in a dry run it is still in the manifest.
    if (surface.managed_marker === MANAGED_TAG || surface.managed_marker === CODEGRAPH_CONFIG_MARKER) continue;
    if (!surface.path.startsWith(join(home, '.codex') + '/') && !surface.path.startsWith(join(home, '.claude') + '/')
      && !surface.path.startsWith(join(home, '.agents') + '/') && !surface.path.startsWith(piSkills + '/') && surface.path !== join(home, '.claude.json')) {
      items.push({ path: surface.path, action: 'preserve', reason: 'package-manager installation retained; remove separately after configuration cleanup' });
      continue;
    }
    try {
      // A receipt may own the final symlink, but never a symlinked parent directory.
      assertConfigurationPath(dirname(surface.path), surfaceRoot(surface.path));
      if (!fileExists(surface.path)) { removedSurfaces.add(surface); continue; }
      if (!managedInstallSurfaceIsCurrent(surface, env)) { unresolved(surface.path, 'owned surface changed since installation; preserved'); continue; }
      remember(surface.path); surfaceRemovals.push(surface);
      items.push({ path: surface.path, action: 'remove', reason: 'unchanged transaction-owned surface' });
      removedSurfaces.add(surface);
    } catch (error) { unresolved(surface.path, String((error as Error).message)); }
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
    for (const name of ['agent-fleet-user-managed.json']) {
      const path = join(home, '.repo-harness', name);
      try { assertConfigurationPath(path, home); if (existsSync(path)) change(path, null, 'product configuration'); }
      catch (error) { unresolved(path, String((error as Error).message)); }
    }
  }

  // Only remove lock entries for staging skills actually removed in this operation.
  const staging = surfaceRemovals.filter((surface) => dirname(surface.path) === stagedSkillRoot(home));
  if (staging.length && existsSync(lock.path)) {
    try {
      assertConfigurationPath(lock.path, lock.root);
      const data = object(read(lock.path));
      if (!data.skills || typeof data.skills !== 'object' || Array.isArray(data.skills)) throw new Error('invalid skills lock; preserved');
      for (const surface of staging) delete data.skills[surface.path.split('/').at(-1)!];
      change(lock.path, `${JSON.stringify(data, null, 2)}\n`, 'removed staging skill registrations');
    } catch (error) {
      unresolved(lock.path, String((error as Error).message));
      // A retry selects lock entries from staging ownership, so keep both.
      for (const surface of staging) {
        surfaceRemovals.splice(surfaceRemovals.indexOf(surface), 1);
        removedSurfaces.delete(surface);
        Object.assign(items.find((item) => item.path === surface.path && item.action === 'remove')!, { action: 'preserve', reason: 'staging skill retained until its lock entry can be removed' });
      }
    }
  }

  const statePath = installProfileStatePath(env);
  if (state) {
    const pending = state.ownership_manifest.filter((surface) => !removedSurfaces.has(surface));
    if (opts.target === 'both' && !pending.some(surface => surface.type === 'pi-package') && !items.some((item) => item.action === 'unresolved')) change(statePath, null, 'install state retired');
    else if (removedSurfaces.size) change(statePath, `${JSON.stringify({ ...state, ownership_manifest: pending, previous: null }, null, 2)}\n`, 'retain remaining ownership for retry/other host');
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
      for (const surface of surfaceRemovals) {
        rmSync(surface.path, { recursive: true, force: true });
      }
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
