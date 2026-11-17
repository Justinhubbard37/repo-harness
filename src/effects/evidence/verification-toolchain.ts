import { captureReadonlyGitTree } from '../git/readonly-virtual-tree';
import {
  currentReadonlyObservation,
  observationReadFileSync as readFileSync,
  observationExecFileSync as execFileSync,
} from '../readonly-observation';
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { delimiter, isAbsolute, join, relative, resolve } from "path";

import { canonicalize } from "../../core/evidence/canonical-json";
import { sha256Prefixed } from "../../core/evidence/sha256";
import type { JsonValue, AdmittedReviewSubjectIdentity, EvalCatalogSubjectIdentity } from "../../core/evidence/types";
import { SECRET_DENYLIST_ENV_KEYS } from "../../core/evidence/redaction";
import {
  fingerprintVerificationCheckExecution,
  type VerificationCheck,
  type VerificationPlan,
} from "../../core/evidence/verification-plan";
import { resolveInsideRepo } from "../path-safety";
import { redactProcessOutput } from "../process-runner";
import { gitExecFileSync } from '../git/runner';

export interface GitVirtualTreeSnapshot {
  readonly head_commit: string;
  readonly tree_hash: string;
  readonly snapshot_hash: string;
}

export type ReviewBinding = Pick<AdmittedReviewSubjectIdentity, "authority_kind" | "campaign_sha256" | "admission_sha256" | "grant_sha256">;
export type EvalBinding = Pick<EvalCatalogSubjectIdentity, "authority_kind" | "catalog_sha256" | "eval_id" | "eval_sha256">;
export type AuthorityBinding = ReviewBinding | EvalBinding;

/** Ledger and admitted plan facts. Historical validation needs no live toolchain. */
export interface EvidenceContext {
  readonly repoRoot: string;
  readonly binding: AuthorityBinding;
  readonly assertCurrent: () => void;
  readonly plan: VerificationPlan;
  readonly planHash: string;
  readonly snapshot: GitVirtualTreeSnapshot;
  readonly env: NodeJS.ProcessEnv;
}

export interface PreparedContext extends EvidenceContext {
  readonly toolchainHash: string;
  readonly envProviderId: string;
}

function git(repoRoot: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return gitExecFileSync(["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function virtualTreeOnce(repoRoot: string): string {
  const temporary = mkdtempSync(join(tmpdir(), "repo-harness-verification-index-"));
  const indexPath = join(temporary, "index");
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    try {
      git(repoRoot, ["read-tree", "HEAD"], indexEnv);
    } catch {
      git(repoRoot, ["read-tree", "--empty"], indexEnv);
    }
    git(repoRoot, ["add", "-A", "--", "."], indexEnv);
    return git(repoRoot, ["write-tree"], indexEnv);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Capture the complete Git-visible filesystem as a virtual tree. A temporary
 * index preserves modes, deletions, symlinks, gitlinks, staged/unstaged edits,
 * and non-ignored untracked files without changing the caller's index.
 */
export function captureGitVirtualTreeSnapshot(repoRoot: string): GitVirtualTreeSnapshot {
  const root = resolve(repoRoot);
  const before = git(root, ["status", "--porcelain=v2", "--untracked-files=all"]);
  const snapshot = currentReadonlyObservation() ? captureReadonlyGitTree : virtualTreeOnce;
  const firstTree = snapshot(root);
  const secondTree = snapshot(root);
  const after = git(root, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (firstTree !== secondTree || before !== after) {
    throw new Error("repository changed while capturing the verification source snapshot");
  }
  let headCommit: string;
  try {
    headCommit = git(root, ["rev-parse", "HEAD"]);
  } catch {
    headCommit = "unborn";
  }
  return {
    head_commit: headCommit,
    tree_hash: firstTree,
    // An empty commit changes provenance but not the source inputs consumed by
    // a check. Keep HEAD in the snapshot record while keying input identity to
    // the complete virtual tree itself.
    snapshot_hash: sha256Prefixed(canonicalize({ tree_hash: firstTree })),
  };
}

function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv): string {
  const candidates = command.includes("/") || command.includes("\\")
    ? [command]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) => {
        const base = join(directory, command);
        if (process.platform !== "win32") return [base];
        const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
        return [base, ...extensions.map((extension) => `${base}${extension.toLowerCase()}`), ...extensions.map((extension) => `${base}${extension.toUpperCase()}`)];
      });
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isFile()) return canonical;
    } catch {
      // Continue through PATH candidates; absence is rejected below.
    }
  }
  throw new Error(`verification toolchain executable is unavailable: ${command}`);
}

function versionOf(command: string, read: () => string): string {
  try {
    const version = read().trim();
    if (!version) throw new Error("empty version output");
    return version;
  } catch (error) {
    throw new Error(`verification toolchain version probe failed for ${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveToolchain(env: NodeJS.ProcessEnv): { readonly hash: string; readonly providerId: string } {
  const git = resolveExecutablePath(env.REPO_HARNESS_GIT_BIN || "git", env);
  const bash = resolveExecutablePath(env.REPO_HARNESS_BASH_BIN || "/bin/bash", env);
  const bun = resolveExecutablePath(env.REPO_HARNESS_BUN_BIN || process.execPath, env);
  const packageRoot = resolve(import.meta.dir, "../../..");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`verification runner package manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packageVersion = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).version
    : undefined;
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("verification runner package version is unavailable");
  }
  const runnerSources = [
    ["verification-execution", join(packageRoot, "src/effects/evidence/verification-execution.ts")],
    ["verification-toolchain", join(packageRoot, "src/effects/evidence/verification-toolchain.ts")],
    ["verification-ledger-view", join(packageRoot, "src/effects/evidence/verification-ledger-view.ts")],
    ["verification-plan", join(packageRoot, "src/core/evidence/verification-plan.ts")],
    ["eval-catalog", join(packageRoot, "src/effects/evidence/eval-catalog.ts")],
    ["evidence-redaction", join(packageRoot, "src/core/evidence/redaction.ts")],
    ["evidence-secret-env", join(packageRoot, "src/effects/evidence/secret-env.ts")],
    ["process-runner", join(packageRoot, "src/effects/process-runner.ts")],
    ["process-supervisor", join(packageRoot, "src/effects/process-supervisor.ts")],
    ["expensive-run-lock", join(packageRoot, "src/effects/expensive-run-lock.ts")],
    ["process-group-launcher", join(packageRoot, "src/effects/process-group-launcher.ts")],
    ["process-group-termination", join(packageRoot, "src/effects/process-group-termination.ts")],
    ["git-runner", join(packageRoot, "src/effects/git/runner.ts")],
    ["git-common-directory", join(packageRoot, "src/effects/git/common-directory.ts")],
    ["exclusive-directory-lock", join(packageRoot, "src/effects/locking/exclusive-directory-lock.ts")],
  ] as const;
  const sourceHashes = Object.fromEntries(runnerSources.map(([name, path]) => {
    try {
      return [name, sha256Prefixed(readFileSync(path))];
    } catch (error) {
      throw new Error(`verification runner source is unavailable (${name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  // File workers share CPU and process startup. Keep discovery bounded under load.
  const probe = { encoding: "utf8" as const, env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], timeout: 15_000 };
  const toolchain = {
    protocol: 1,
    package_version: packageVersion,
    runner_sources: sourceHashes,
    platform: { os: process.platform, arch: process.arch },
    path: env.PATH ?? null,
    tools: {
      git: { path: git, version: versionOf(git, () => gitExecFileSync(["--version"], { ...probe, gitBin: git })) },
      bash: { path: bash, version: versionOf(bash, () => execFileSync(bash, ["--version"], probe)) },
      bun: { path: bun, version: versionOf(bun, () => execFileSync(bun, ["--version"], probe)) },
    },
  };
  const hash = sha256Prefixed(canonicalize(toolchain));
  return { hash, providerId: `verification-execution/${hash}` };
}

function declaredEnvironment(check: VerificationCheck, env: NodeJS.ProcessEnv): JsonValue {
  return Object.fromEntries(check.inputs.env.map((name) => [
    name,
    env[name] === undefined ? { present: false } : { present: true, value_hash: sha256Prefixed(env[name]!) },
  ])) as JsonValue;
}

export function declaredEnvironmentHash(check: VerificationCheck, env: NodeJS.ProcessEnv): string {
  return sha256Prefixed(canonicalize(declaredEnvironment(check, env)));
}

export function cacheKeyFromIdentity(input: {
  readonly check: VerificationCheck;
  readonly snapshotHash: string;
  readonly toolchainHash: string;
  readonly inputsHash: string;
}): string {
  return sha256Prefixed(canonicalize({
    protocol: 1,
    execution_spec_hash: fingerprintVerificationCheckExecution(input.check),
    snapshot_hash: input.snapshotHash,
    cwd: input.check.cwd,
    toolchain_hash: input.toolchainHash,
    inputs_hash: input.inputsHash,
  }));
}

export function cacheKey(context: PreparedContext, check: VerificationCheck): string {
  return cacheKeyFromIdentity({
    check,
    snapshotHash: context.snapshot.snapshot_hash,
    toolchainHash: context.toolchainHash,
    inputsHash: declaredEnvironmentHash(check, context.env),
  });
}

export function displayCommand(check: VerificationCheck): string {
  return redactProcessOutput(check.kind === "command" ? check.command : `bun run test -- ${check.path}`);
}

export function resolveExecutionCwd(repoRoot: string, cwd: string): string {
  const lexical = cwd === "." ? repoRoot : resolveInsideRepo(repoRoot, cwd);
  const lexicalPath = typeof lexical === "string" ? lexical : (lexical.ok ? lexical.path : undefined);
  if (!lexicalPath) throw new Error(typeof lexical === "string" ? "invalid cwd" : lexical.error);
  const canonicalRoot = realpathSync(repoRoot);
  const canonicalCwd = realpathSync(lexicalPath);
  const fromRoot = relative(canonicalRoot, canonicalCwd);
  if (fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) {
    throw new Error(`verification cwd resolves outside the repository: ${cwd}`);
  }
  if (!statSync(canonicalCwd).isDirectory()) throw new Error(`verification cwd is not a directory: ${cwd}`);
  return canonicalCwd;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith("../") && !fromRoot.startsWith("..\\"));
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function resolvePackageTest(
  context: PreparedContext,
  check: Extract<VerificationCheck, { readonly kind: "package_test" }>,
): { readonly command: string; readonly args: readonly string[]; readonly cwd: string } {
  const canonicalRoot = realpathSync(context.repoRoot);
  const declaredCwd = resolveExecutionCwd(context.repoRoot, check.cwd);
  let testPath: string;
  try {
    testPath = realpathSync(resolve(declaredCwd, check.path));
  } catch {
    throw new Error(`package_test path is missing or symlink-ambiguous: ${check.path}`);
  }
  if (!isWithin(canonicalRoot, testPath)) throw new Error(`package_test path resolves outside repository: ${check.path}`);

  let ancestor = statSync(testPath).isDirectory() ? testPath : resolve(testPath, "..");
  while (isWithin(canonicalRoot, ancestor)) {
    const manifest = join(ancestor, "package.json");
    if (pathEntryExists(manifest)) {
      let canonicalManifest: string;
      try {
        canonicalManifest = realpathSync(manifest);
      } catch {
        throw new Error(`package_test package manifest is symlink-ambiguous: ${check.path}`);
      }
      if (canonicalManifest !== manifest || !isWithin(canonicalRoot, canonicalManifest)) {
        throw new Error(`package_test package manifest is symlink-ambiguous: ${check.path}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(canonicalManifest, "utf8"));
      } catch {
        throw new Error(`package_test package manifest is malformed: ${check.path}`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`package_test package manifest is malformed: ${check.path}`);
      }
      const scripts = (parsed as Record<string, unknown>).scripts;
      if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
        throw new Error(`package_test package scripts.test is missing: ${check.path}`);
      }
      const testScript = (scripts as Record<string, unknown>).test;
      if (typeof testScript !== "string" || testScript.trim().length === 0) {
        throw new Error(`package_test package scripts.test is missing: ${check.path}`);
      }
      const owner = relative(canonicalRoot, ancestor) || ".";
      const testRelative = relative(ancestor, testPath);
      const bun = context.env.REPO_HARNESS_BUN_BIN || process.execPath;
      return { command: bun, args: ["run", "--cwd", owner, "test", "--", testRelative], cwd: canonicalRoot };
    }
    if (ancestor === canonicalRoot) break;
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error(`package_test package owner is missing: ${check.path}`);
}

export function verificationChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "BASH_ENV" || key.startsWith("REPO_HARNESS_")) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

export function redactKnownEnvironmentValues(value: string, env: NodeJS.ProcessEnv): string {
  let redacted = value;
  const secrets = SECRET_DENYLIST_ENV_KEYS
    .map((key) => env[key])
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) redacted = redacted.split(secret).join(sha256Prefixed(secret));
  return redacted;
}
