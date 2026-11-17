/**
 * Mutation guard: the in-process decision handler for `PreToolUse.edit`.
 *
 * Target paths come from `tool_input.file_path`, or from the apply_patch text in `tool_input.command`; input without a parseable
 * target fails closed. The safety hook's I2 rule then judges each target. A denial writes one stderr reason with its fix and one
 * failure record. An allowed edit can carry the `[CapabilityOwner]` line.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, join, posix, sep, win32 } from 'path';
import { canonicalRepoRelativePath } from '../../effects/state/collect-state-inputs';
import { parseStatusZ, splitNul } from '../../effects/review/diff-fingerprint';
import {
  capabilityOwnersForPaths,
  FAILURE_LOG_FILE,
  type CapabilityPathOwner,
} from '../../effects/state/resolve-effective-state';
import type { HookPermission } from './handler-contract';
import { payloadString, type HookIdentity, type HookPayload } from './hook-input';
import { writeTargetDenial, type TargetKind, type WriteTarget } from './safety-hook';
import { gitExecFileSync } from '../../effects/git/runner';
import { replaceSecrets } from '../../core/security/secret-patterns';

export interface MutationGuardInput {
  readonly repoRoot: string;
  readonly payload: HookPayload;
  readonly identity: HookIdentity;
  readonly env: NodeJS.ProcessEnv;
}

export interface MutationGuardResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly permission?: HookPermission;
}

export interface Denial {
  readonly guard: string;
  readonly reason: string;
  readonly fix: string;
  /** The user can authorize the call locally (I2), so an interactive Claude session asks instead of denying. */
  readonly askable?: true;
}

/**
 * Claude modes in which a hook ask is not shown to reach the user, so an ask could pass unseen. These sessions, the owner's
 * bypass sessions included, get the deny. A payload without a mode also gets the deny.
 */
const NO_PROMPT_MODES = new Set(['bypassPermissions', 'dontAsk']);

const APPLY_PATCH_SCOPE_DENIAL: Denial = {
  guard: 'ApplyPatchScopeGuard',
  reason: 'Codex apply_patch input did not expose a parseable target path.',
  fix: 'Use a standard *** Add/Update/Delete File patch header so every target can be checked before the write.',
};

const EDIT_SCOPE_DENIAL: Denial = {
  guard: 'EditScopeGuard',
  reason: 'Edit input did not expose a target path in tool_input.file_path.',
  fix: 'Send the target path in tool_input.file_path so it can be checked before the write.',
};

interface EditTarget { readonly kind: TargetKind; readonly raw: string }

export function runMutationGuard(opts: MutationGuardInput): MutationGuardResult {
  const { repoRoot, payload } = opts;
  const command = payloadString(payload, 'tool_input.command');
  const filePath = payloadString(payload, 'tool_input.file_path');
  // Edit and Write name one file that they change or replace.
  const targets: readonly EditTarget[] = command ? extractApplyPatchTargets(command) : (filePath ? [{ kind: 'overwrite', raw: filePath }] : []);
  if (targets.length === 0) return deny(repoRoot, command ? APPLY_PATCH_SCOPE_DENIAL : EDIT_SCOPE_DENIAL, opts.identity.runId);
  // The path keeps its `..` parts: the kernel follows each link before the `..` after it.
  const writes: WriteTarget[] = targets.map(({ kind, raw }) => ({ kind, via: command ? 'apply_patch' : 'the edit', spelled: raw, path: isAbsolute(raw) ? raw : `${repoRoot}${sep}${raw}` }));
  const userStep = (path: string) => `the user can edit ${path} themselves`;
  const denial = writeTargetDenial(writes, { repoRoot, env: opts.env, host: opts.identity.host }, userStep);
  if (denial) return runMutationDenial(opts, denial);
  return { exitCode: 0, stdout: capabilityOwnerLines(repoRoot, targets.map(({ raw }) => normalizeFilePath(repoRoot, raw))), stderr: '' };
}

/** A caller that owns its own decision reports it through the same denial record and exit code. */
export function runMutationDenial(opts: MutationGuardInput, found: Denial): MutationGuardResult {
  // The reason and fix quote the command, which can hold a token; the prompt, stderr and failure record get the redacted text.
  const denial: Denial = { ...found, reason: replaceSecrets(found.reason), fix: replaceSecrets(found.fix) };
  const mode = payloadString(opts.payload, 'permission_mode');
  if (denial.askable && opts.identity.host === 'claude' && mode !== '' && !NO_PROMPT_MODES.has(mode)) {
    return { exitCode: 0, stdout: '', stderr: '', permission: { decision: 'ask', reason: `[${denial.guard}] ${denial.reason}` } };
  }
  return deny(opts.repoRoot, denial, opts.identity.runId);
}

function deny(repoRoot: string, denial: Denial, runId: string | null): MutationGuardResult {
  let stderr = `[${denial.guard}] ${denial.reason}\n  Fix: ${denial.fix}\n`;
  // The failure record is a diagnostic. Its I/O error must not escape: the
  // runtime turns a throw on this route into a crash block, which would
  // replace this denial's own reason.
  try {
    appendFailureRecord(repoRoot, denial, runId);
  } catch (error) {
    stderr += `[${denial.guard}] Failure log not written: ${error instanceof Error ? error.message : String(error)}\n`;
  }
  return { exitCode: 2, stdout: '', stderr };
}

/**
 * The owner line appears on the first edit of an owned path after its last
 * commit: Git, not a session cursor, says whether the path already changed.
 * The Git check runs only when an ownership authority exists, and ownership
 * resolves only for clean paths, so an edit of a changed path skips
 * `archctx resolve`. Architecture diagnostics never block, so an ownership
 * or Git failure only drops the line.
 */
function capabilityOwnerLines(repoRoot: string, paths: readonly string[]): string {
  const repoPaths = [...new Set(paths.filter(isRepoScopedPath))];
  if (repoPaths.length === 0) return '';
  let owners: ReadonlyMap<string, CapabilityPathOwner>;
  try {
    owners = capabilityOwnersForPaths(repoRoot, repoPaths, (surfaces) => pathsWithNoUncommittedChange(repoRoot, surfaces));
  } catch {
    return '';
  }
  let lines = '';
  for (const filePath of repoPaths) {
    const owner = owners.get(filePath);
    if (owner) lines += `[CapabilityOwner] ${filePath} belongs to ${owner.id}${owner.module_document === null ? '' : ` (${owner.module_document})`}.\n`;
  }
  return lines;
}

/** One `git status` for the batch; a Git failure treats every path as changed. */
function pathsWithNoUncommittedChange(repoRoot: string, paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return paths;
  let changed: readonly string[];
  try {
    changed = parseStatusZ(splitNul(gitExecFileSync(['-C', repoRoot, '--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }))).all;
  } catch {
    return [];
  }
  return paths.filter((path) => !changed.some((entry) => entry === path || entry.startsWith(`${path}/`)));
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

function isRepoScopedPath(filePath: string): boolean {
  return filePath.length > 0 && !isAbsolutePathInAnyGrammar(filePath);
}

function isAbsolutePathInAnyGrammar(filePath: string): boolean {
  return posix.isAbsolute(filePath)
    || win32.isAbsolute(filePath)
    || /^[A-Za-z]:/.test(filePath);
}

function normalizeFilePath(repoRoot: string, raw: string): string {
  return canonicalRepoRelativePath(repoRoot, raw) ?? raw;
}

// ---------------------------------------------------------------------------
// apply_patch target paths
// ---------------------------------------------------------------------------

// Matches what codex-cli 0.160.0 applies. It trims a file hunk header with
// Rust `str::trim` before it matches the marker, so leading and trailing
// Unicode White_Space is allowed there. That set includes U+0085 and excludes
// U+FEFF, so JS `\s` does not fit. `*** Move to: ` must start at column 0;
// only its trailing whitespace is trimmed. Inner path whitespace is kept.
const PATCH_WS = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const APPLY_PATCH_FILE_LINE = new RegExp(`^${PATCH_WS}*\\*\\*\\* (Add|Update|Delete) File: (.+?)${PATCH_WS}*$`, 's');
const APPLY_PATCH_MOVE_LINE = new RegExp(`^\\*\\*\\* Move to: (.+?)${PATCH_WS}*$`, 's');

/**
 * Add and Update write file content (through a link); Delete removes the entry. Move to writes its destination and removes the
 * Update source entry.
 */
function extractApplyPatchTargets(command: string): readonly EditTarget[] {
  const targets: EditTarget[] = [];
  let update: string | null = null;
  for (const line of command.split('\n')) {
    const fileMatch = APPLY_PATCH_FILE_LINE.exec(line);
    const moveMatch = fileMatch ? null : APPLY_PATCH_MOVE_LINE.exec(line);
    if (fileMatch) {
      targets.push({ kind: fileMatch[1] === 'Delete' ? 'destroy' : 'overwrite', raw: fileMatch[2]! });
      update = fileMatch[1] === 'Update' ? fileMatch[2]! : null;
    } else if (moveMatch) {
      targets.push({ kind: 'overwrite', raw: moveMatch[1]! });
      if (update !== null) targets.push({ kind: 'destroy', raw: update });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Failure record
// ---------------------------------------------------------------------------

function appendFailureRecord(repoRoot: string, denial: Denial, runId: string | null): void {
  const target = join(repoRoot, FAILURE_LOG_FILE);
  mkdirSync(dirname(target), { recursive: true });
  const record = {
    ts: formatIsoWithNumericOffset(new Date()),
    guard: denial.guard,
    action: 'block',
    reason: denial.reason,
    fix: denial.fix,
    failure_class: 'state_violation',
    run_id: runId,
  };
  appendFileSync(target, `${JSON.stringify(record)}\n`);
}

/** Local time with a numeric offset and no colon, e.g. `2026-10-13T09:00:00+0800`. */
function formatIsoWithNumericOffset(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const offsetMinutesTotal = -date.getTimezoneOffset();
  const offsetSign = offsetMinutesTotal >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutesTotal) / 60));
  const offsetMinutes = pad(Math.abs(offsetMinutesTotal) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offsetSign}${offsetHours}${offsetMinutes}`
  );
}
