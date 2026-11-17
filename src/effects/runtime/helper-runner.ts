import { existsSync, lstatSync, readFileSync } from 'fs';
import { dirname, extname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runProcess as runBoundedProcess } from '../process-runner';
import { runGit } from '../git/run-git';
import { trustedNodeCandidates } from './node-candidates';
import { selectCompatibleNode } from './node-runtime';
import { engines } from '../../../package.json';
import {
  protectedHelperRuntimeEnv,
  resolveProtectedHelperPlatform,
  resolveTrustedGhExecutable,
  type ProtectedHelperPlatform,
} from './protected-helper-platform';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
// Packaged authoring scripts are the sole executable helper authority.
// Frozen downstream templates are scaffold inputs, never a runtime fallback.
const PACKAGE_HELPERS_ROOT = join(PACKAGE_ROOT, 'scripts');
const PACKAGE_CONTRACT = join(PACKAGE_ROOT, 'assets', 'workflow-contract.v1.json');
const PROTECTED_HELPERS = new Set(['acceptance-receipt', 'contract-worktree', 'ship-worktrees', 'merge-gate']);
const VERIFIER_HELPER_TIMEOUT_MS = 3_660_000;
const CLOSEOUT_HELPER_TIMEOUT_MS = 900_000;
const ORDINARY_HELPER_TIMEOUT_MS = 120_000;

const HOST_GH = resolveTrustedGhExecutable();

function protectedPath(runtime: ProtectedHelperPlatform): string {
  return [...new Set([
    ...runtime.pathEntries,
    ...(HOST_GH ? [dirname(HOST_GH)] : []),
  ])].join(runtime.pathDelimiter);
}

function trustedNodeRuntime(runtime: ProtectedHelperPlatform): string | undefined {
  const selected = selectCompatibleNode({
    range: engines.node,
    candidates: trustedNodeCandidates(runtime.accountHome),
    versionOf(actual) {
      const result = runBoundedProcess(actual, ['--version'], {
        env: { PATH: protectedPath(runtime) },
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      return result.status === 0 ? result.stdout.trim().replace(/^v/, '') : null;
    },
  });
  return selected.status === 'selected' ? selected.path : undefined;
}

function copyAllowedEnv(source: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv, keys: readonly string[]): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export function protectedChildEnv(
  source: NodeJS.ProcessEnv,
  runtime: ProtectedHelperPlatform = resolveProtectedHelperPlatform(),
): NodeJS.ProcessEnv {
  const nodeRuntime = trustedNodeRuntime(runtime);
  const env: NodeJS.ProcessEnv = {
    ...protectedHelperRuntimeEnv(runtime),
    PATH: protectedPath(runtime),
    REPO_HARNESS_PROTECTED_PATH: protectedPath(runtime),
    ...(nodeRuntime ? { REPO_HARNESS_NODE_BIN: nodeRuntime } : {}),
  };
  copyAllowedEnv(source, env, [
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'NO_COLOR',
    'FORCE_COLOR',
    'HOOK_HOST',
    'REPO_HARNESS_WORKTREE_ROOT',
  ]);
  return env;
}

export type HelperSource = 'source' | 'package';

export interface ResolvedHelper {
  id: string;
  fileName: string;
  path: string;
  source: HelperSource;
  repoRoot: string;
}

export interface RunHelperOptions {
  /** Apply the existing package/runtime trust fence to this authority-sensitive invocation. */
  trustedPackage?: true;
  helper: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | 'ignore';
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunHelperResult {
  exitCode: number;
  reason: 'missing-helper' | 'internal-helper' | 'spawn-error' | 'timeout' | 'ok';
  helper: string;
  resolved?: ResolvedHelper;
  stdout?: string;
  stderr?: string;
}

export interface HelperDescriptor {
  id: string;
  description: string;
}

function helperId(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

export function helperTimeoutMs(helper: string): number {
  switch (helperId(helper)) {
    case 'verify-sprint':
      return VERIFIER_HELPER_TIMEOUT_MS;
    case 'contract-worktree':
    case 'merge-gate':
    case 'ship-worktrees':
      return CLOSEOUT_HELPER_TIMEOUT_MS;
    default:
      return ORDINARY_HELPER_TIMEOUT_MS;
  }
}

type HelperRuntime = {
  contractPath: string;
  helpersRoot: string;
  source: HelperSource;
};

function helperContractError(contractPath: string, detail: string): Error {
  return new Error(`invalid helper contract at ${contractPath}: ${detail}`);
}

function readContractHelpersObject(contractPath: string): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(contractPath, 'utf-8');
  } catch {
    throw new Error(`helper contract not found: ${contractPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw helperContractError(contractPath, `malformed JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw helperContractError(contractPath, 'root must be an object');
  }
  const helpers = (parsed as { helpers?: unknown }).helpers;
  if (typeof helpers !== 'object' || helpers === null || Array.isArray(helpers)) {
    throw helperContractError(contractPath, 'helpers must be an object');
  }
  return helpers as Record<string, unknown>;
}

type ContractHelpers = {
  /** Every shipped helper file, public and internal. */
  fileNames: string[];
  /** Helper ids that only `rh` subcommands run; `rh run` refuses them. */
  internal: ReadonlySet<string>;
  helpers: Record<string, unknown>;
};

function readContractHelpers(contractPath: string): ContractHelpers {
  const helpers = readContractHelpersObject(contractPath);
  const scripts = helpers.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    throw helperContractError(contractPath, 'helpers.scripts must be a non-empty array');
  }

  const fileNames = new Set<string>();
  const ids = new Set<string>();
  for (const entry of scripts) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.includes('/') ||
      entry.includes('\\') ||
      !['.sh', '.ts'].includes(extname(entry))
    ) {
      throw helperContractError(contractPath, `helpers.scripts contains unsafe helper name ${JSON.stringify(entry)}`);
    }
    if (fileNames.has(entry)) {
      throw helperContractError(contractPath, `duplicate helper file ${JSON.stringify(entry)}`);
    }
    fileNames.add(entry);

    const id = helperId(entry);
    if (!id) {
      throw helperContractError(contractPath, `helpers.scripts contains empty helper id ${JSON.stringify(entry)}`);
    }
    if (ids.has(id)) {
      throw helperContractError(contractPath, `duplicate helper id ${JSON.stringify(id)}`);
    }
    ids.add(id);
  }

  return { fileNames: [...fileNames], internal: readInternalHelperIds(contractPath, helpers.internal, ids), helpers };
}

function readInternalHelperIds(contractPath: string, internal: unknown, ids: ReadonlySet<string>): ReadonlySet<string> {
  if (internal === undefined) return new Set();
  if (!Array.isArray(internal)) throw helperContractError(contractPath, 'helpers.internal must be an array');
  for (const [index, id] of internal.entries()) {
    if (typeof id !== 'string' || !ids.has(id)) {
      throw helperContractError(contractPath, `helpers.internal names helper id ${JSON.stringify(id)}, which is not in helpers.scripts`);
    }
    if (index > 0 && internal[index - 1] >= id) {
      throw helperContractError(contractPath, `helpers.internal must be sorted and unique at ${JSON.stringify(id)}`);
    }
  }
  return new Set(internal as string[]);
}

function readContractHelperDescriptions(
  contractPath: string,
  contract: ContractHelpers,
): Record<string, string> {
  const descriptions = contract.helpers.descriptions;
  if (typeof descriptions !== 'object' || descriptions === null || Array.isArray(descriptions)) {
    throw helperContractError(contractPath, 'helpers.descriptions must be an object');
  }

  const ids = contract.fileNames.map(helperId);
  const idSet = new Set(ids);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(descriptions as Record<string, unknown>)) {
    if (!idSet.has(key)) {
      throw helperContractError(contractPath, `helpers.descriptions has unknown helper id ${JSON.stringify(key)}`);
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw helperContractError(contractPath, `helpers.descriptions.${key} must be a non-empty string`);
    }
    result[key] = value;
  }

  for (const id of ids) {
    if (!(id in result)) {
      throw helperContractError(contractPath, `helpers.descriptions is missing entry for helper id ${JSON.stringify(id)}`);
    }
  }

  return result;
}

function isProtectedHelper(helper: string): boolean {
  return PROTECTED_HELPERS.has(helperId(helper));
}

function resolveHelperRuntime(env: NodeJS.ProcessEnv, allowSourceOverride = true): HelperRuntime {
  const sourceRoot = env.REPO_HARNESS_SOURCE_ROOT?.trim();
  if (sourceRoot && allowSourceOverride) {
    if (!isAbsolute(sourceRoot)) {
      throw new Error('REPO_HARNESS_SOURCE_ROOT must be an absolute path');
    }
    return {
      contractPath: join(sourceRoot, 'assets', 'workflow-contract.v1.json'),
      helpersRoot: join(sourceRoot, 'scripts'),
      source: 'source',
    };
  }

  return {
    contractPath: PACKAGE_CONTRACT,
    helpersRoot: PACKAGE_HELPERS_ROOT,
    source: 'package',
  };
}

/** Every shipped helper file, public and internal. */
export function listHelperFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = resolveHelperRuntime(env);
  return readContractHelpers(runtime.contractPath).fileNames;
}

/** The helper ids that `rh run` accepts. */
export function listHelperIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const contract = readContractHelpers(resolveHelperRuntime(env).contractPath);
  return contract.fileNames.map(helperId).filter((id) => !contract.internal.has(id));
}

/** The helper ids that only `rh` subcommands run, through `runInternalHelper`. */
export function listInternalHelperIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = resolveHelperRuntime(env);
  return [...readContractHelpers(runtime.contractPath).internal];
}

/** The public helpers with their contract descriptions. */
export function listHelpers(env: NodeJS.ProcessEnv = process.env): HelperDescriptor[] {
  const runtime = resolveHelperRuntime(env);
  const contract = readContractHelpers(runtime.contractPath);
  const descriptions = readContractHelperDescriptions(runtime.contractPath, contract);
  return contract.fileNames.map(helperId).filter((id) => !contract.internal.has(id)).map((id) => ({ id, description: descriptions[id] }));
}

function resolveHelperFileName(helper: string, files: readonly string[]): string | null {
  if (extname(helper)) return files.includes(helper) ? helper : null;
  return files.find((fileName) => helperId(fileName) === helper) ?? null;
}

function resolveRepoRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
  protectedHelper: boolean,
  runtime: ProtectedHelperPlatform | null,
): string {
  const result = runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], {
    gitBin: runtime?.gitBin,
    env: protectedHelper ? protectedChildEnv(env, runtime!) : env,
    inheritEnv: !protectedHelper,
    timeoutMs: 5000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function resolveFromDir(
  fileName: string,
  dir: string,
  source: HelperSource,
  repoRoot: string,
): ResolvedHelper {
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`contract helper is missing from ${source} runtime: ${filePath}`);
  }
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`contract helper is not a regular file: ${filePath}`);
  }
  return { id: helperId(fileName), fileName, path: filePath, source, repoRoot };
}

type HelperVisibility = 'public' | 'internal';

type ResolvedHelperContext =
  | { kind: 'missing' }
  /** The helper exists, but its `helpers.internal` membership does not match the requested visibility. */
  | { kind: 'refused'; id: string; internal: boolean }
  | { kind: 'resolved'; resolved: ResolvedHelper; runtime: ProtectedHelperPlatform | null };

function resolveHelperContext(
  helper: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  trustedPackage = false,
  visibility?: HelperVisibility,
): ResolvedHelperContext {
  const protectedHelper = trustedPackage || isProtectedHelper(helper);
  const helperRuntime = resolveHelperRuntime(env, !protectedHelper);
  const contract = readContractHelpers(helperRuntime.contractPath);
  const fileName = resolveHelperFileName(helper, contract.fileNames);
  if (!fileName) return { kind: 'missing' };
  // The visibility refusal needs only the contract, so it does not depend on the host runtime or the repository.
  const internal = contract.internal.has(helperId(fileName));
  if (visibility !== undefined && internal !== (visibility === 'internal')) return { kind: 'refused', id: helperId(fileName), internal };

  const protectedRuntime = protectedHelper ? resolveProtectedHelperPlatform() : null;
  const repoRoot = resolveRepoRoot(cwd, env, protectedHelper, protectedRuntime);
  return {
    kind: 'resolved',
    resolved: resolveFromDir(fileName, helperRuntime.helpersRoot, helperRuntime.source, repoRoot),
    runtime: protectedRuntime,
  };
}

/** Resolve a shipped helper file, public or internal. */
export function resolveHelper(helper: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ResolvedHelper | null {
  const context = resolveHelperContext(helper, cwd, env);
  return context.kind === 'resolved' ? context.resolved : null;
}

/** Run a public helper. An internal helper is refused with reason `internal-helper` and does not run. */
export function runHelper(opts: RunHelperOptions): RunHelperResult {
  return executeHelper(opts, 'public');
}

/** Run an internal helper for an `rh` subcommand, under the same runtime, timeout and protected-helper rules as `runHelper`. */
export function runInternalHelper(opts: Omit<RunHelperOptions, 'trustedPackage'>): RunHelperResult {
  return executeHelper(opts, 'internal');
}

function executeHelper(opts: RunHelperOptions, visibility: HelperVisibility): RunHelperResult {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.trustedPackage ? (opts.env ?? process.env) : { ...process.env, ...(opts.env ?? {}) };
  let context: ResolvedHelperContext;
  try {
    context = resolveHelperContext(opts.helper, cwd, env, opts.trustedPackage, visibility);
  } catch (error) {
    return {
      exitCode: 1,
      reason: 'spawn-error',
      helper: opts.helper,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (context.kind === 'missing') {
    return {
      exitCode: 2,
      reason: 'missing-helper',
      helper: opts.helper,
      stderr: `rh run: unknown helper "${opts.helper}"`,
    };
  }
  if (context.kind === 'refused') {
    // An internal refusal names the canonical id, so `rh run` can map it to its public command.
    return context.internal
      ? { exitCode: 2, reason: 'internal-helper', helper: context.id, stderr: `rh run: helper "${context.id}" is internal` }
      : { exitCode: 2, reason: 'missing-helper', helper: opts.helper, stderr: `unknown internal helper "${opts.helper}"` };
  }
  const resolved = context.resolved;

  const args = [...(opts.args ?? [])];
  const protectedHelper = opts.trustedPackage || isProtectedHelper(opts.helper);
  const trustedBash = context.runtime?.bashBin ?? 'bash';
  const trustedGit = context.runtime?.gitBin ?? 'git';
  const command = resolved.fileName.endsWith('.sh') ? trustedBash : process.execPath;
  const childEnv: NodeJS.ProcessEnv = {
    ...(protectedHelper ? protectedChildEnv(env, context.runtime!) : env),
    REPO_HARNESS_HELPER_SOURCE_PATH: resolved.path,
    REPO_HARNESS_TARGET_REPO_ROOT: resolved.repoRoot,
  };
  try {
    if (protectedHelper) {
      childEnv.REPO_HARNESS_BASH_BIN = trustedBash;
      childEnv.REPO_HARNESS_GIT_BIN = trustedGit;
      childEnv.REPO_HARNESS_BUN_BIN = process.execPath;
      childEnv.REPO_HARNESS_CLI_BIN = resolveFromDir(
        'index.ts', join(PACKAGE_ROOT, 'src', 'cli'), 'package', resolved.repoRoot,
      ).path;
      childEnv.REPO_HARNESS_HOOK_CLI = resolveFromDir(
        'hook-entry.ts', join(PACKAGE_ROOT, 'src', 'cli'), 'package', resolved.repoRoot,
      ).path;
      if (HOST_GH) childEnv.REPO_HARNESS_GH_BIN = HOST_GH;
      else delete childEnv.REPO_HARNESS_GH_BIN;
    }
  } catch (error) {
    return {
      exitCode: 1, reason: 'spawn-error', helper: opts.helper, resolved,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const child = runBoundedProcess(command, [resolved.path, ...args], {
    cwd: resolved.repoRoot,
    env: childEnv,
    inheritEnv: !protectedHelper,
    stdio: opts.stdio ?? 'inherit',
    timeoutMs: opts.timeoutMs ?? helperTimeoutMs(resolved.id),
    maxOutputBytes: opts.maxOutputBytes,
    processGroup: true,
    taskkillBin: context.runtime?.taskkillBin,
  });

  if (child.error) {
    return {
      exitCode: 1,
      reason: child.timedOut ? 'timeout' : 'spawn-error',
      helper: opts.helper,
      resolved,
      stderr: child.stderr || child.error,
    };
  }

  return {
    exitCode: child.status ?? 1,
    reason: 'ok',
    helper: opts.helper,
    resolved,
    stdout: child.stdout || undefined,
    stderr: child.stderr || undefined,
  };
}
