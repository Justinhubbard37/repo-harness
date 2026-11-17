import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { managedBlockMarker, renderManagedBlock } from '../../core/adoption/managed-block';
import { ignoreBlockProof, removeRuntimeStateIgnoreBlock, runtimeStateIgnoreOperation, userExcludesFilePath } from '../../effects/adoption/gitignore-plan';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { withoutRepositorySelectingGitEnv } from '../../effects/git/runner';
import { isRepoHarnessAdoptedPath, readRepoHarnessRegistryStrictSnapshot } from '../../effects/repo-registry';
import { writePrivateConfiguration } from './configuration-ownership';
import { repoHarnessHome } from '../../effects/repo-harness-home';
import { readPathRecords } from '../../effects/host-config/path-records';
import { installProfileStatePath } from './install-state';

/** One repository write: the resolved `info/exclude` of a repository's Git common directory. */
export interface RepositoryExclude { readonly repo_id: string; readonly repo_path: string; readonly exclude_path: string }

export function repositoryExcludesLedgerPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(installProfileStatePath(env)), 'repository-excludes.json');
}

export function readRepositoryExcludes(env: NodeJS.ProcessEnv): RepositoryExclude[] {
  const path = repositoryExcludesLedgerPath(env);
  if (!lstatSync(path, { throwIfNoEntry: false })) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const valid = (entry: Record<string, unknown>) => Object.keys(entry).sort().join(',') === 'exclude_path,repo_id,repo_path'
    && Object.values(entry).every((field) => typeof field === 'string');
  if (value?.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(valid)) throw new Error(`repository_excludes_ledger_invalid: ${path}`);
  return value.entries;
}

export function serializeRepositoryExcludes(entries: readonly RepositoryExclude[]): string | null {
  return entries.length ? `${JSON.stringify({ version: 1, entries }, null, 2)}\n` : null;
}

/**
 * A path with its links followed: realpath.native of the path; for a missing path, the target of a
 * dangling link (relative to the link's directory), else the resolved parent and the remaining name.
 */
function followLinks(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return followLinks(resolve(dirname(path), readlinkSync(path)));
    return join(followLinks(dirname(path)), basename(path));
  }
}

/**
 * Upserts the runtime-state block in Git ignore text read as latin1, so each user byte is one
 * character and every byte outside the block span is written back unchanged.
 */
function upsertRuntimeBlock(path: string, existing: string): { content: string; outcome: 'written' | 'current' | 'kept' } {
  const operation = runtimeStateIgnoreOperation(path);
  const block = renderManagedBlock(operation);
  const { begin, end } = managedBlockMarker(operation.marker);
  const lines = existing.split(/(?<=\n)/);
  const bare = lines.map((line) => line.replace(/\r?\n$/, ''));
  const start = bare.indexOf(begin);
  const stop = bare.indexOf(end);
  if (start === -1 && stop === -1) {
    // One blank separator line, which the block removal drops again.
    const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { content: `${existing}${separator}${block}\n`, outcome: 'written' };
  }
  if (start === -1 || stop < start || bare.indexOf(begin, start + 1) !== -1) throw new Error(`${path}: unbalanced runtime-state ignore block; fix its markers, then run rh update again`);
  const current = bare.slice(start, stop + 1).join('\n');
  if (current === block) return { content: existing, outcome: 'current' };
  if (!ignoreBlockProof(operation)(current)) return { content: existing, outcome: 'kept' };
  const eol = lines[stop].slice(bare[stop].length);
  return { content: `${lines.slice(0, start).join('')}${block}${eol}${lines.slice(stop + 1).join('')}`, outcome: 'written' };
}

/** rh refuses only a write into its own home or into a path that the install ledger records for another owner. */
function assertWriteTarget(path: string, env: NodeJS.ProcessEnv): void {
  const owned = Object.keys(readPathRecords(env));
  for (const root of [repoHarnessHome(env), dirname(installProfileStatePath(env)), ...owned]) {
    const resolved = followLinks(root);
    if (path === resolved || path.startsWith(resolved + sep)) {
      throw new Error(`excludes_target_rh_managed: ${path} is in ${root}, which rh manages; fix the link, or remove the repository from the registry, then run the command again`);
    }
  }
}

/**
 * The Git common directory of a registered repository. Inherited repository-selecting variables
 * (GIT_DIR from a Git hook, for example) would point every repository at one directory, so they are removed.
 */
export function repositoryCommonDirectory(repoPath: string, env: NodeJS.ProcessEnv): string {
  return resolveGitCommonDirectory(repoPath, undefined, undefined, withoutRepositorySelectingGitEnv(env));
}

/**
 * `<common dir>/info/exclude` of a repository (`git rev-parse --git-common-dir`) with user links followed,
 * so worktrees, gitdir links and linked exclude files of one repository share one owner and one ledger key.
 */
export function repositoryExcludeTarget(commonDir: string, env: NodeJS.ProcessEnv): string {
  const path = followLinks(join(commonDir, 'info', 'exclude'));
  assertWriteTarget(path, env);
  return path;
}

/**
 * `incomplete` names each registered repository that does not hold a proved block (missing, not a
 * Git repository, or an edited block); `targets` holds the resolved exclude files that rh wrote or proved.
 */
export interface RepositoryExcludesResult { readonly status: 'ok' | 'failed'; readonly detail: string; readonly incomplete: readonly string[]; readonly targets: readonly string[] }

/**
 * Writes the runtime-state block into the exclude file of each adopted repository in the registry.
 * The ledger names a target before its first write, so uninstall finds every block that rh wrote.
 * Every caller holds the global runtime lock, so block updates are serialized.
 */
export function writeRepositoryExcludes(env: NodeJS.ProcessEnv): RepositoryExcludesResult {
  const lines: string[] = [];
  const unavailable: string[] = [];
  const edited: string[] = [];
  const owners = new Map<string, string>();
  const incomplete = () => [...unavailable, ...edited.map((path) => `${path}: edited block`)];
  const failed = (error: unknown) => ({ status: 'failed' as const, detail: [...lines, error instanceof Error ? error.message : String(error)].join('; '), incomplete: incomplete(), targets: [...owners.keys()] });
  let ledger: RepositoryExclude[];
  let repos;
  try {
    ledger = readRepositoryExcludes(env);
    repos = [...readRepoHarnessRegistryStrictSnapshot({ env }).repos].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) { return failed(error); }
  for (const repo of repos) {
    if (!existsSync(repo.path)) { unavailable.push(`${repo.path}: missing`); continue; }
    if (!isRepoHarnessAdoptedPath(repo.path)) continue;
    let commonDir: string;
    try { commonDir = repositoryCommonDirectory(repo.path, env); }
    catch { unavailable.push(`${repo.path}: not a Git repository`); continue; }
    try {
      const path = repositoryExcludeTarget(commonDir, env);
      if (owners.has(path)) { lines.push(`${path}: written for ${owners.get(path)}`); continue; }
      owners.set(path, repo.path);
      if (!ledger.some((entry) => entry.exclude_path === path)) {
        ledger = [...ledger, { repo_id: repo.id, repo_path: repo.path, exclude_path: path }];
        writePrivateConfiguration(repositoryExcludesLedgerPath(env), serializeRepositoryExcludes(ledger)!, env.HOME ?? homedir());
      }
      const update = upsertRuntimeBlock(path, existsSync(path) ? readFileSync(path, 'latin1') : '');
      if (update.outcome === 'kept') {
        edited.push(path);
        lines.push(`${path}: kept the edited block; delete it, then run rh update again to get the current one`);
      } else if (update.outcome === 'current') lines.push(`${path}: current`);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, update.content, 'latin1');
        lines.push(`${path}: written`);
      }
    } catch (error) { return failed(error); }
  }
  if (unavailable.length) lines.push(`unavailable registered repositories: ${unavailable.join(', ')}`);
  return { status: 'ok', detail: lines.join('; ') || 'no adopted repository is registered', incomplete: incomplete(), targets: [...owners.keys()] };
}

/**
 * One-shot migration (#2844): earlier releases wrote the runtime-state block to the user-level
 * Git excludes file. Update removes only that block, after every registered repository holds its
 * own proved block; a failed, unavailable or edited repository block keeps it, and so does a user-level
 * file that is itself a repository exclude target. User links are followed.
 */
export function retireUserExcludesBlock(env: NodeJS.ProcessEnv, repositories: RepositoryExcludesResult): { status: 'ok' | 'skipped'; detail: string } {
  const excludes = userExcludesFilePath(env);
  if (!excludes.ok) return { status: 'skipped', detail: `user-level Git excludes file not resolved; nothing removed: ${excludes.error}` };
  const path = excludes.path;
  try {
    if (!existsSync(path)) return { status: 'skipped', detail: `${path}: absent` };
    const removal = removeRuntimeStateIgnoreBlock(readFileSync(path, 'latin1'));
    if (removal.status === 'none') return { status: 'skipped', detail: `${path}: no runtime-state block` };
    if (repositories.status !== 'ok' || repositories.incomplete.length) {
      return { status: 'skipped', detail: `${path}: kept the runtime-state block until every registered repository holds its own proved block` };
    }
    if (repositories.targets.includes(followLinks(path))) {
      return { status: 'skipped', detail: `${path}: kept the runtime-state block; this file is also a repository exclude file` };
    }
    if (removal.status !== 'removed') {
      return { status: 'skipped', detail: `${path}: kept the ${removal.status} runtime-state block; move your rules outside the markers, then delete the block` };
    }
    assertWriteTarget(followLinks(path), env);
    writeFileSync(path, removal.content, 'latin1');
    return { status: 'ok', detail: `${path}: removed the runtime-state block; each adopted repository holds it in .git/info/exclude` };
  } catch (error) {
    return { status: 'skipped', detail: `${path}: kept the runtime-state block: ${error instanceof Error ? error.message : String(error)}` };
  }
}
