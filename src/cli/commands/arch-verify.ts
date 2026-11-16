// `rh arch verify --base <ref> [--json]`: one verdict over the ArchContext
// checks of a change. Every read is read-only and every check keeps its own
// status, so a check that cannot observe its subject never becomes a pass.

import {
  ARCH_VERIFY_CHECK_IDS,
  archVerifyExitCode,
  buildArchVerifyReport,
  formatArchVerifyText,
  type ArchVerifyCheckId,
  type ArchVerifyCheckRead,
} from '../../core/architecture/arch-verify';
import { ARCHCTX_REQUIRED_VERSION } from '../../core/architecture/projection';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { gitSpawnSync } from '../../effects/git/runner';
import { ARCH_VERIFY_READ_FAILED, readArchVerification, type ArchitectureVerifyArgs } from '../../effects/architecture/architecture-read';

export const ARCH_VERIFY_BASE_INVALID = 'arch_verify_base_invalid';
export const ARCH_VERIFY_USAGE = 'arch_verify_usage';

/** The archctx command of each check, bound to the resolved base commit. */
function checkArgs(id: ArchVerifyCheckId, baseSha: string): ArchitectureVerifyArgs {
  switch (id) {
    case 'validate': return ['validate', '--format', 'json'];
    case 'flows': return ['flows', 'check', '--no-sync', '--json'];
    case 'state-machines': return ['state-machines', 'check', '--json'];
    case 'constraints': return ['constraints', 'check', '--json'];
    case 'docs': return ['docs', 'anchors', '--json'];
    case 'projection': return ['projection', 'verify-pr', '--base', baseSha, '--json'];
    case 'debt': return ['debt', '--json'];
  }
}

/** A full commit, or null when git cannot resolve the ref. */
export function resolveCommit(repoRoot: string, ref: string): string | null {
  const result = gitSpawnSync(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
}

/** The repository root of the working directory, or null outside a Git worktree. */
export function resolveWorktreeRoot(cwd: string): string | null {
  const result = gitSpawnSync(['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = result.status === 0 ? result.stdout.trim() : '';
  return root === '' ? null : root;
}

export interface ArchVerifyCommandOptions { readonly base?: string; readonly json?: boolean }

export type ArchVerifyCommandResult =
  | { readonly ok: true; readonly exitCode: 0 | 1 | 2; readonly document: string }
  | { readonly ok: false; readonly exitCode: 2; readonly error: string };

/** Runs every check with the policy timeout and builds the one document. Writes no file. */
export function archVerify(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  json: boolean,
  options: ArchctxProviderOptions = {},
): ArchVerifyCommandResult {
  const reads = ARCH_VERIFY_CHECK_IDS.map((id) => {
    let read: ArchVerifyCheckRead;
    try { read = readArchVerification(repoRoot, checkArgs(id, baseSha), options); }
    catch (error) { read = { ok: false, error: { code: ARCH_VERIFY_READ_FAILED, message: error instanceof Error ? error.message : String(error) } }; }
    return { id, read };
  });
  const report = buildArchVerifyReport({ base: baseSha, head: headSha, archctxVersion: ARCHCTX_REQUIRED_VERSION, reads });
  return { ok: true, exitCode: archVerifyExitCode(report.verdict), document: json ? `${JSON.stringify(report, null, 2)}\n` : formatArchVerifyText(report) };
}

/** A usage error and an unresolvable base both exit 2 before any check runs. */
export function runArchVerifyCommand(
  cwd: string,
  options: ArchVerifyCommandOptions,
  providerOptions: ArchctxProviderOptions = {},
): ArchVerifyCommandResult {
  if (options.base === undefined || options.base === '') {
    return { ok: false, exitCode: 2, error: `${ARCH_VERIFY_USAGE}: --base <ref> is required` };
  }
  const repoRoot = resolveWorktreeRoot(cwd);
  if (repoRoot === null) return { ok: false, exitCode: 2, error: `${ARCH_VERIFY_USAGE}: not inside a Git worktree` };
  const baseSha = resolveCommit(repoRoot, options.base);
  if (baseSha === null) return { ok: false, exitCode: 2, error: `${ARCH_VERIFY_BASE_INVALID}: ${options.base}` };
  const headSha = resolveCommit(repoRoot, 'HEAD');
  if (headSha === null) return { ok: false, exitCode: 2, error: `${ARCH_VERIFY_USAGE}: HEAD resolves to no commit` };
  return archVerify(repoRoot, baseSha, headSha, options.json === true, providerOptions);
}

/** `arch-actions` loads this module only after the architecture selection check. */
export function runArchVerify(options: ArchVerifyCommandOptions, cwd: string = process.cwd()): void {
  const result = runArchVerifyCommand(cwd, options);
  if (result.ok) process.stdout.write(result.document);
  else process.stderr.write(`${result.error}\n`);
  process.exitCode = result.exitCode;
}
