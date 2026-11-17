import { osAccountHome } from '../runtime/os-account-home';
import { gitSpawnSync } from '../git/runner';
import { assertObservationPath, observationReadFileSync as readFileSync } from '../readonly-observation';
import { existsSync, lstatSync, realpathSync } from 'fs';
import { userInfo } from 'os';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { fail } from '../../core/review/acceptance-receipt';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(MODULE_DIR, '../../..');
type ProtectedRuntime = {
  platform: NodeJS.Platform;
  accountHome: string;
  accountUsername: string;
  gitBin: string;
  bashBin: string;
  bunExecutable: string;
  pathEntries: readonly string[];
  pathDelimiter: ':' | ';';
  tempDir: string;
  systemRoot?: string;
};
type ProtectedPlatformModule = {
  resolveProtectedHelperPlatform: () => ProtectedRuntime;
  protectedHelperRuntimeEnv: (runtime: ProtectedRuntime) => NodeJS.ProcessEnv;
};
type ProtectedGitRuntime = {
  readonly gitBin: string;
  readonly env: NodeJS.ProcessEnv;
};
export const requireFromHelper = createRequire(import.meta.url);
let protectedGitRuntimeCache: ProtectedGitRuntime | null = null;

function fixedPosixExecutable(label: string, candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    const source = lstatSync(candidate);
    if (source.isSymbolicLink() || !source.isFile()) continue;
    const actual = realpathSync(candidate);
    const target = lstatSync(actual);
    if (target.isSymbolicLink() || !target.isFile() || (target.mode & 0o111) === 0) continue;
    return actual;
  }
  throw new Error(`required system executable is unavailable: ${label}`);
}

export function resolveProtectedGitRuntime(): ProtectedGitRuntime {
  if (protectedGitRuntimeCache) return protectedGitRuntimeCache;
  if (process.platform !== 'win32') {
    const account = userInfo();
    const gitBin = fixedPosixExecutable('git', ['/usr/bin/git', '/bin/git']);
    const bashBin = fixedPosixExecutable('bash', ['/bin/bash']);
    const protectedPath = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    protectedGitRuntimeCache = {
      gitBin,
      env: {
        HOME: osAccountHome(),
        USER: account.username,
        LOGNAME: account.username,
        PATH: protectedPath,
        TMPDIR: '/tmp',
        REPO_HARNESS_BASH_BIN: bashBin,
        REPO_HARNESS_GIT_BIN: gitBin,
        REPO_HARNESS_BUN_BIN: process.execPath,
        REPO_HARNESS_PROTECTED_PATH: protectedPath,
        REPO_HARNESS_PROTECTED_TMPDIR: '/tmp',
      },
    };
    return protectedGitRuntimeCache;
  }
  const protectedPlatform = requireFromHelper(
    join(PACKAGE_ROOT, 'src', 'effects', 'runtime', 'protected-helper-platform.ts'),
  ) as ProtectedPlatformModule;
  const runtime = protectedPlatform.resolveProtectedHelperPlatform();
  protectedGitRuntimeCache = {
    gitBin: runtime.gitBin,
    env: protectedPlatform.protectedHelperRuntimeEnv(runtime),
  };
  return protectedGitRuntimeCache;
}


function gitText(root: string, args: string[]): string {
  const runtime = resolveProtectedGitRuntime();
  const result = gitSpawnSync(['-C', root, ...args], { gitBin: runtime.gitBin, encoding: 'utf-8', env: runtime.env });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim() || 'unknown error'}`);
  return result.stdout.trim();
}

export function repositoryRoot(cwd = process.cwd()): string {
  return realpathSync(gitText(cwd, ['rev-parse', '--show-toplevel']));
}

function repoRelative(root: string, path: string): string {
  const absolute = realpathSync(resolve(root, path));
  const value = relative(root, absolute).replaceAll('\\', '/');
  if (!value || value.startsWith('../') || isAbsolute(value)) fail(`path escapes repository: ${path}`);
  return value;
}

export function readRegular(root: string, requested: string, label: string): { path: string; content: string } {
  assertObservationPath(resolve(root, requested));
  const absolute = resolve(root, requested);
  if (!existsSync(absolute)) fail(`${label} is missing: ${requested}`);
  const actual = realpathSync(absolute);
  const path = repoRelative(root, actual);
  if (!lstatSync(actual).isFile()) fail(`${label} must be a regular file: ${path}`);
  return { path, content: readFileSync(actual, 'utf-8') };
}



export function unsafeRepoRelativePath(value: string): boolean {
  return value.length === 0
    || isAbsolute(value)
    || value.startsWith('-')
    || value.includes('\\')
    || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..');
}


export function verificationReportFile(root: string, requested: string): { path: string; content: string } {
  if (isAbsolute(requested) || requested.includes('\\') || requested.split('/').some(part => part === '..' || part === '.')
    || !requested.startsWith('.ai/harness/runs/')) fail('AcceptanceReceipt verification_file is unsafe: use an explicit repository-relative report under .ai/harness/runs/');
  const absolute = resolve(root, requested);
  if (!existsSync(absolute)) fail('verification evidence is missing: ' + requested);
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()
    || realpathSync(absolute) !== absolute) fail('verification evidence must be a regular non-symlink report');
  return readRegular(root, requested, 'verification evidence');
}
