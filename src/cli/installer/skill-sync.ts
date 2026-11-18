import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashManagedTree, installedCopyTreeOptions, managedTreeEntries, OWNER_MARKER } from '../../effects/managed-tree';
import { parseSkillSurfaceCatalog } from '../../core/skill-surface/catalog';
import { parsePluginList, PLUGIN_IDS } from '../../core/skill-surface/plugin-manifest';
import { requireHome } from '../../effects/repo-harness-home';
import { openHostConfigGate } from '../../effects/host-config/gate';
import { runProcess } from '../../effects/process-runner';
import { planSkillSync, withHostConfigTransaction } from './install-profile';
import { atomicWriteFileSync } from './shared';

/** Build a new copy in rh's transaction directory. Host publication stays at the gate. */
export function stageInstalledSkillCopy(source: string, surface: 'canonical-skill' | 'command-facade', transaction: string,
  contract: Parameters<typeof installedCopyTreeOptions>[1]): string {
  const projection = installedCopyTreeOptions(surface, contract);
  const staged = mkdtempSync(join(transaction, 'skill-copy-'));
  for (const entry of managedTreeEntries(source, projection)) {
    const destination = join(staged, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, entry.path), destination, { verbatimSymlinks: true });
  }
  writeFileSync(join(staged, OWNER_MARKER), JSON.stringify({ owner: 'repo-harness', surface, content_hash: hashManagedTree(staged) }) + '\n');
  return staged;
}

/** Run the shell writer with the gate's declared destinations. */
export function syncInstalledSkillCopies(sourceRoot: string, env: NodeJS.ProcessEnv, transaction?: string,
  script = join(sourceRoot, 'scripts', 'sync-codex-installed-copies.sh')) {
  requireHome(env);
  const selection = env.REPO_HARNESS_INSTALL_PLUGINS;
  const plugins = selection === undefined ? PLUGIN_IDS : selection === '' ? [] : parsePluginList(selection);
  const manifest = join(sourceRoot, 'assets/skill-commands/manifest.json');
  const catalog = parseSkillSurfaceCatalog(readFileSync(manifest, 'utf8'), { declared: true });
  if (catalog.status !== 'valid') throw new Error('invalid skill-surface catalog: ' + manifest);
  const { declared, retired } = planSkillSync(plugins, env, catalog.catalog);
  return withHostConfigTransaction(env, transaction, root => {
    let result: ReturnType<typeof runProcess> | undefined;
    openHostConfigGate({ env }).delegate(declared, () => {
      if (declared.some(({ path }) => /[\r\n]/.test(path))) throw new Error('skill path contains a newline');
      const plan = mkdtempSync(join(root, 'skill-sync-'));
      const declaredFile = join(plan, 'declared-paths');
      const retiredFile = join(plan, 'retired-paths');
      atomicWriteFileSync(declaredFile, declared.map(entry => entry.path).join('\n') + '\n', { mode: 0o600 });
      atomicWriteFileSync(retiredFile, retired.join('\n') + '\n', { mode: 0o600 });
      result = runProcess(env.REPO_HARNESS_SYNC_SHELL ?? 'bash', [script], { cwd: sourceRoot, env: { ...env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', REPO_HARNESS_SOURCE_ROOT: sourceRoot, REPO_HARNESS_SYNC_DECLARED_PATHS_FILE: declaredFile,
        REPO_HARNESS_SYNC_RETIRED_PATHS_FILE: retiredFile } });
      if (!result.ok) throw new Error(result.stderr || result.error || 'skill sync failed');
    }, { transaction: root });
    return result!;
  });
}
