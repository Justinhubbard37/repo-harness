import { assertObservationPath, currentReadonlyObservation, withReadonlyObservation, type ReadonlyObservationIO } from '../readonly-observation';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { statSync } from 'fs';
import { buildReviewSubject, isImplementationSurfacePath, type ReviewSubject } from '../review/diff-fingerprint';
import { resolveWorkflowProfile } from '../../core/workflow/profile';
import type {
  EffectiveState,
  EffectiveStateRiskInput,
  StateSnapshot,
} from '../../core/state/types';
import { projectEffectiveState } from '../../core/state/project-effective-state';
import {
  projectStateSnapshot,
  type StateSnapshotCompatibilityFacts,
} from '../../core/state/project-state-snapshot';
import {
  commitStateVersionAfter,
  currentStateVersion,
  StateVersionConfirmMismatchError,
  type StateVersionWriteEffects,
} from './git-state-version-store';
import { withStateLock } from './state-lock';
import {
  collectStateInputs,
  contentRevision,
  fileExists,
  readText,
  readTrimmed,
  repoPath,
  safeRealpath,
  sourceHash,
} from './collect-state-inputs';
import { gitExecFileSync } from '../git/runner';
import { POLICY_PATH } from '../../core/workflow/policy-schema';
import { capabilitySourceMode, policyPath, policyReviewBase, readWorkflowPolicy, type WorkflowPolicy } from './state-policy';
import {
  capabilityAuthorityHash,
  capabilityAuthoritySourcePaths,
  capabilityIdsForPathGroups,
  capabilityOwnershipFrom,
  owedOwnershipSubject,
  type CapabilityResolution,
} from './state-capability-ownership';

export {
  FAILURE_LOG_FILE,
  capabilitySourceMode,
  policyReviewBase,
  readWorkflowPolicy,
  readWorkflowPolicyDocument,
  resolveHarnessPaths,
  type HarnessPaths,
  type WorkflowPolicy,
} from './state-policy';
export {
  CapabilityOwnershipError,
  capabilityOwnersForPaths,
  loadRegistryAuthority,
  resolveCapabilityOwnership,
  resolveReviewBase,
  type CapabilityPathOwner,
  type CapabilityRegistryStatus,
  type CapabilityResolution,
} from './state-capability-ownership';

const ACTIVE_WORKTREE_MARKER = '.ai/harness/active-worktree';
// profile_reasons names at most this many unowned paths; the count reason carries the total.
const UNOWNED_PATH_REASON_LIMIT = 20;

export interface EffectiveStatePublicationEffects {
  readonly version?: StateVersionWriteEffects;
}

function pendingState(cwd: string, nowMs: number, policy: WorkflowPolicy): 'none' | 'fresh' | 'stale' {
  const pendingPath = policyPath(
    policy,
    'planning.pending_orchestration_file',
    '.ai/harness/planning/pending.json',
  );
  if (!fileExists(cwd, pendingPath)) return 'none';
  let stat;
  try {
    stat = statSync(repoPath(cwd, pendingPath));
    if (stat.size <= 0) return 'none';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1000));
  if (ageSeconds <= 259200) return 'fresh';
  return 'stale';
}

/**
 * `source_hashes` keys the stability contract's re-read comparison ignores:
 * high-churn, non-authority surfaces whose instability must not abort
 * resolution (root-cause-prover diagnosis, 2026-07-23 -- see
 * .ai/harness/runs/hook-guard-stability/). Only the observed review subject
 * remains; workflow-authority surfaces (the active-worktree marker, policy,
 * the capability registry, and the derived authority_revision) keep the full
 * stability contract unchanged.
 */
const NON_AUTHORITY_SOURCE_HASH_KEYS: ReadonlySet<string> = new Set([
  'review_subject',
]);

/** Projects `sourceHashes` onto the workflow-authority subset the stability
 * contract's re-read comparison uses to decide whether to retry or throw. */
function authoritySourceHashes(
  sourceHashes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const authority: Record<string, string> = {};
  for (const key of Object.keys(sourceHashes)) {
    if (!NON_AUTHORITY_SOURCE_HASH_KEYS.has(key)) authority[key] = sourceHashes[key];
  }
  return authority;
}

function collectStateSnapshotFacts(
  cwd: string,
  nowMs: number,
): StateSnapshotCompatibilityFacts {
  return {
    spec: fileExists(cwd, 'docs/spec.md') ? 'present' : 'missing',
    pending: pendingState(cwd, nowMs, readWorkflowPolicy(cwd)),
  };
}

/** Parse the canonical issue branch once for state and SessionStart task context. */
export function parseIssueBranch(branch: string): { issue: number; slug: string } | null {
  const match = /^[^/]+\/([1-9]\d*)-([^/]+)$/.exec(branch);
  if (!match) return null;
  const issue = Number(match[1]);
  return Number.isSafeInteger(issue) && issue > 0 ? { issue, slug: match[2]! } : null;
}

/**
 * The next unit when the branch is the canonical `<type>/<digits>-<slug>` form:
 * the branch names one GitHub issue and the message names both. Any other
 * branch (no issue, a leading zero, no slug, extra path segments, detached
 * HEAD) yields null, so the continuation envelope stays idle. It reads Git
 * only.
 */
function branchIssueNextAction(cwd: string): string | null {
  let branch: string;
  try {
    branch = gitExecFileSync(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const task = parseIssueBranch(branch);
  return task ? `Continue GitHub issue #${task.issue} on branch ${branch}.` : null;
}

/**
 * Resolve all workflow projections into one fail-closed, versioned state model.
 * Markdown remains the human-editable authority.
 */
function resolveEffectiveStateUnlocked(
  cwd: string,
  nowMs: number,
  reviewSubjectFor: ReviewSubjectSlot,
  options: { risk?: EffectiveStateRiskInput; branchNextAction?: string | null },
): EffectiveState {
  const currentWorktree = safeRealpath(cwd);
  // Only these named facts are shared, and only within this unlocked read-only
  // pass. Every subsequent initial/confirmation pass owns a fresh map.
  const captured = currentReadonlyObservation() ? new Map<string, string | null>() : null;
  const readSource = (path: string): string | null => {
    if (captured?.has(path)) { assertObservationPath(repoPath(cwd, path)); return captured.get(path)!; }
    const text = readText(cwd, path);
    captured?.set(path, text);
    return text;
  };
  const hashSource = (path: string): string => {
    const text = readSource(path);
    return text === null ? sha256Prefixed(`missing:${path}`) : sha256Prefixed(text);
  };
  const policy = readWorkflowPolicy(cwd, readSource);
  const capabilitySource = capabilitySourceMode(policy);
  const owner = readTrimmed(cwd, ACTIVE_WORKTREE_MARKER);
  const conflictingSources: string[] = [];
  const staleSources: string[] = [];

  if (owner && safeRealpath(owner) !== currentWorktree) {
    conflictingSources.push('worktree_owner');
  }

  const reviewSubject = reviewSubjectFor(policyReviewBase(policy));
  const explicitTargetPaths = options.risk?.targetPaths ?? [];
  const implementationDiffPaths = reviewSubject.status === 'ok' ? reviewSubject.paths : [];
  const rawTargetPaths = Array.from(new Set([...explicitTargetPaths, ...implementationDiffPaths])).sort();
  const hasRawTargetPaths = rawTargetPaths.length > 0;

  // C2: medium-scope, cross-capability, and strict-token signals count only
  // implementation surfaces. Workflow-surface paths (plans/tasks/docs/.ai/
  // .claude/.codex + markdown) are ceremony/administrative edits that stay
  // editable without an active plan (pre-edit-guard.sh's
  // is_workflow_surface_path already exempts them from the plan/strict
  // gates); counting them toward the risk floor previously inflated a
  // docs-only session's internally resolved profile even though the gates
  // themselves stayed silent about it -- and once ceremony guidance keys off
  // the resolved profile (Phase B2), the inflated profile surfaces the wrong
  // guidance.
  const implementationTargetPaths = rawTargetPaths.filter(isImplementationSurfacePath);
  const observedTargetPaths = hasRawTargetPaths ? implementationTargetPaths : undefined;

  // C1: structured, fail-closed capability registry resolution. A registry
  // the caller declared explicitly is trusted as-is; otherwise resolve it
  // from the implementation-surface path set (capabilityIdsForPaths' contract
  // is stated in terms of "implementation paths").
  let owedSubject: ReviewSubject | null = null;
  // Owed ownership is advisory and does not feed state_revision or source_hashes.
  // Bounded observers keep review/risk reads and do not request owed Git history.
  if (!options.risk?.capabilityIds && !currentReadonlyObservation()) {
    try { owedSubject = owedOwnershipSubject(cwd, reviewSubject); }
    catch { /* Architecture diagnostics do not block risk resolution. */ }
  }
  const owedPaths = owedSubject
    ? Array.from(new Set([...explicitTargetPaths, ...(owedSubject.status === 'ok' ? owedSubject.paths : [])])).sort().filter(isImplementationSurfacePath)
    : [];
  const [riskOwnership, owedOwnership] = options.risk?.capabilityIds || (!hasRawTargetPaths && owedPaths.length === 0)
    ? []
    : capabilityIdsForPathGroups(cwd, [implementationTargetPaths, owedPaths], policy, readSource);
  const capabilityResolution: CapabilityResolution | null = options.risk?.capabilityIds
    ? { ids: options.risk.capabilityIds, registryStatus: 'valid', matches: [], unmappedPaths: [], malformedEntryCount: 0, outOfRepoPathCount: 0, blocker: null }
    : hasRawTargetPaths ? riskOwnership! : null;
  const observedCapabilityIds = capabilityResolution?.ids;
  const unmappedCapabilityCount = capabilityResolution?.unmappedPaths.length ?? 0;
  const outOfRepoPathCount = capabilityResolution?.outOfRepoPathCount ?? 0;
  // capabilityCount is always an explicit number (never left undefined) once
  // there are any raw target paths, so an all-workflow-surface batch (whose
  // implementationTargetPaths is empty) resolves the deterministic "known,
  // zero implementation surface" lite floor instead of tripping
  // resolveWorkflowProfile's signals-unavailable fail-closed branch -- that
  // branch exists for the genuinely unknown case (no target paths at all),
  // which stays untouched below.
  // Out-of-repo and unowned paths remain diagnostic-only: neither is a
  // capability, so neither contributes to capabilityCount. A new file next to
  // an owned file must not read as a second capability.
  const declaredCapabilityCount = options.risk?.capabilityCount ?? (
    hasRawTargetPaths ? (observedCapabilityIds?.length ?? 0) : undefined
  );

  const riskResolution = resolveWorkflowProfile({
    targetPaths: observedTargetPaths,
    // C2 filters workflow-surface paths (docs/*, *.md, ...) out of
    // observedTargetPaths before medium-scope/cross-capability counting, but
    // a workflow-surface path can still carry a real strict-category token
    // (e.g. docs/auth/runbook.md) -- strictScanPaths carries the pre-filter
    // raw batch so resolveWorkflowProfile's strict-token scan sees it, while
    // targetPathCount/mediumScope/crossCapability stay on the filtered set.
    strictScanPaths: rawTargetPaths,
    capabilityIds: observedCapabilityIds,
    capabilityCount: declaredCapabilityCount,
    operationKind: options.risk?.operationKind ?? (
      observedTargetPaths && observedTargetPaths.length > 0 ? 'edit' : 'inspect'
    ),
    explicitOverride: options.risk?.explicitOverride,
  });

  const worktreeOwnerIsCurrent = Boolean(owner && safeRealpath(owner) === currentWorktree);
  // Capability registry reasons are appended to profile_reasons alongside
  // resolveWorkflowProfile's own reasons rather than folded into the resolver
  // itself -- the risk-floor ranking formula is untouched; only the reason
  // text is additive.
  const capabilityReasons: string[] = [];
  const capabilityBlocker = capabilityResolution?.blocker ?? null;
  if (capabilityResolution?.registryStatus === 'absent') {
    capabilityReasons.push('capability:registry:absent');
  } else if (capabilityBlocker?.key === 'capability_ownership:unavailable') {
    capabilityReasons.push('capability:ownership:unavailable');
  } else if (capabilityResolution?.registryStatus === 'invalid') {
    capabilityReasons.push('capability:registry:invalid');
  }
  if (capabilityBlocker) capabilityReasons.push(`capability:diagnostic:${capabilityBlocker.code}`);
  if (capabilityResolution && capabilityResolution.malformedEntryCount > 0) {
    capabilityReasons.push(`capability:registry:malformed-entries:${capabilityResolution.malformedEntryCount}`);
  }
  if (unmappedCapabilityCount > 0) {
    capabilityReasons.push(`capability:unowned:${unmappedCapabilityCount}`);
    capabilityReasons.push(...capabilityResolution!.unmappedPaths
      .slice(0, UNOWNED_PATH_REASON_LIMIT)
      .map((path) => `capability:unowned-path:${path}`));
  }
  if (outOfRepoPathCount > 0) {
    capabilityReasons.push(`capability:out-of-repo:${outOfRepoPathCount}`);
  }

  const reviewSubjectSha256 = reviewSubject.status === 'ok' ? reviewSubject.review_subject_sha256 : null;

  // Keep authority, observed Git subject and display projections separate.
  const authorityRevision = contentRevision({
    active_worktree: sourceHash(cwd, ACTIVE_WORKTREE_MARKER),
    policy: captured ? hashSource(POLICY_PATH) : sourceHash(cwd, POLICY_PATH),
    capability_registry: capabilityAuthorityHash(cwd, capabilitySource, captured ? hashSource : undefined),
  });
  const subjectRevision = contentRevision({
    review_subject: reviewSubjectSha256 ?? sha256Prefixed('unavailable:review-subject'),
    target_rev: reviewSubject.status === 'ok' ? sha256Prefixed(reviewSubject.target_rev) : sha256Prefixed('unavailable:target-rev'),
  });
  // Every display projection (handoff, resume, task snapshot) is retired, so
  // the projection set is empty and its revision is the empty-set digest.
  const projectionRevision = contentRevision({});

  const sourcePaths = [
    ACTIVE_WORKTREE_MARKER,
    POLICY_PATH,
    ...capabilityAuthoritySourcePaths(cwd, capabilitySource),
  ];
  const collected = collectStateInputs(cwd, sourcePaths.filter(path => !captured?.has(path)), {
    ...Object.fromEntries(sourcePaths.filter(path => captured?.has(path)).map(path => [path, hashSource(path)])),
    ...(reviewSubjectSha256 ? { review_subject: reviewSubjectSha256 } : {}),
    authority_revision: authorityRevision,
  });
  const sourceHashes = collected.sourceHashes;
  const stateRevision = collected.stateRevision;
  return projectEffectiveState({
    nowMs,
    riskResolution,
    requestedWorkflowProfile: options.risk?.explicitOverride ?? null,
    capabilityReasons,
    capabilityBlocker,
    capabilityOwnership: capabilityOwnershipFrom(
      owedSubject ? owedOwnership ?? null : null,
      Boolean(options.risk?.capabilityIds),
      reviewSubject.status === 'ok' ? reviewSubject.target_rev : null,
    ),
    staleSources,
    conflictingSources,
    activeWorktreePath: ACTIVE_WORKTREE_MARKER,
    currentWorktree,
    worktreeOwner: owner,
    worktreeOwnerIsCurrent,
    branchNextAction: options.branchNextAction ?? null,
    authorityRevision,
    subjectRevision,
    projectionRevision,
    stateVersion: 0,
    stateRevision,
    sourceHashes,
  });
}

/**
 * Builds the Git review subject for one stability pass. A pass asks for the
 * subject with the review base of its own policy read. The slot builds it on
 * the first call, reuses it while the review base stays the same, and builds
 * it again when the review base changes. Each stability pass takes a new slot,
 * so each pass observes Git itself. Nothing is cached across resolutions.
 */
type ReviewSubjectSlot = (targetRef: string) => ReviewSubject;

function reviewSubjectSlot(cwd: string): ReviewSubjectSlot {
  let subject: ReviewSubject | null = null;
  return (targetRef) => {
    if (subject === null || subject.target_ref !== targetRef) subject = buildReviewSubject(cwd, { targetRef });
    return subject;
  };
}

/** Evidence is excluded from authority comparisons. Keep partial states private. */
function resolveAuthoritySourceHashes(
  cwd: string,
  nowMs: number,
  reviewSubjectFor: ReviewSubjectSlot,
  risk?: EffectiveStateRiskInput,
): Readonly<Record<string, string>> {
  return authoritySourceHashes(
    resolveEffectiveStateUnlocked(cwd, nowMs, reviewSubjectFor, { risk }).source_hashes,
  );
}

/**
 * Thrown when the stability contract exhausts its bounded re-reads because an
 * authority source kept changing across them. Sustained concurrent authority
 * churn, not an unresolvable workflow profile, so callers classify this by type
 * and may retry.
 */
export class StateResolutionUnstableError extends Error {
  constructor() {
    super('workflow authority changed repeatedly while resolving effective state');
    this.name = 'StateResolutionUnstableError';
  }
}

/**
 * Run one stable-resolve + version-commit attempt. The version lock's
 * `confirmSnapshot` seam re-collects source hashes immediately before the
 * candidate version is computed and compares them against this attempt's own
 * `confirmed.source_hashes`; a mismatch means a source mutated after the
 * stability loop returned but before allocation, so it throws
 * `StateVersionConfirmMismatchError` with no owner write --
 * `resolveEffectiveState` below decides whether to retry. The confirm callback
 * reuses the review subject slot of the confirmed pass, because it compares
 * authority hashes for the commit window only. The slot still builds the
 * subject again if the policy review base changed.
 */
function resolveAndCommitEffectiveState(
  cwd: string,
  nowMs: number,
  risk: EffectiveStateRiskInput | undefined,
  publicationEffects: EffectiveStatePublicationEffects | undefined,
): EffectiveState {
  const { state: confirmed, reviewSubjectFor } = resolveStableEffectiveState(cwd, nowMs, risk);
  const version = commitStateVersionAfter(cwd, confirmed.state_revision, publicationEffects?.version, () => {
    return JSON.stringify(resolveAuthoritySourceHashes(cwd, nowMs, reviewSubjectFor, risk))
      === JSON.stringify(authoritySourceHashes(confirmed.source_hashes));
  });
  return { ...confirmed, state_version: version };
}

/**
 * The only `state_version` publisher. Its production caller is
 * `rh state resolve`; every other reader uses
 * `resolveEffectiveStateReadOnly`.
 */
export function resolveEffectiveState(
  cwd = process.cwd(),
  nowMs = Date.now(),
  risk?: EffectiveStateRiskInput,
  publicationEffects?: EffectiveStatePublicationEffects,
): EffectiveState {
  return withStateLock(cwd, () => {
    try {
      return resolveAndCommitEffectiveState(cwd, nowMs, risk, publicationEffects);
    } catch (error) {
      if (!(error instanceof StateVersionConfirmMismatchError)) throw error;
    }
    // One bounded outer retry of the whole stable-resolve + commit sequence:
    // a fresh stability loop re-reads sources and each of its passes observes
    // the review subject again (now reflecting whatever mutated the first
    // attempt's confirm window), and a fresh commit attempt re-checks its own
    // window. A second mismatch here means sources kept changing across the
    // retry too, so this reuses the existing stability-exhausted error rather
    // than inventing new vocabulary.
    try {
      return resolveAndCommitEffectiveState(cwd, nowMs, risk, publicationEffects);
    } catch (error) {
      if (error instanceof StateVersionConfirmMismatchError) {
        throw new StateResolutionUnstableError();
      }
      throw error;
    }
  });
}

/**
 * The no-write resolution for hooks, MCP and the other readers. It returns the
 * last published `state_version`, which can belong to another revision of any
 * linked worktree; `state_revision` identifies the content.
 */
export function resolveEffectiveStateReadOnly(
  cwd = process.cwd(),
  nowMs = Date.now(),
  risk?: EffectiveStateRiskInput,
  observation?: ReadonlyObservationIO,
): EffectiveState {
  const collect = () => {
    const { state: confirmed } = resolveStableEffectiveState(cwd, nowMs, risk);
    return { ...confirmed, state_version: currentStateVersion(cwd) };
  };
  return observation ? withReadonlyObservation(observation, collect) : collect();
}

/**
 * One stable attempt. Each stability pass (the authority pass and each
 * confirmed pass) takes a new review subject slot and observes Git once. The
 * published state therefore uses a subject from the same pass as its other
 * reads. The slot of the confirmed pass is returned for the confirm callback.
 */
function resolveStableEffectiveState(
  cwd: string,
  nowMs: number,
  risk?: EffectiveStateRiskInput,
): { state: EffectiveState; reviewSubjectFor: ReviewSubjectSlot } {
  // One Git read per resolution, not per stability pass: the next unit does
  // not enter the authority hashes the passes compare.
  const branchNextAction = branchIssueNextAction(cwd);
  let authority = resolveAuthoritySourceHashes(cwd, nowMs, reviewSubjectSlot(cwd), risk);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reviewSubjectFor = reviewSubjectSlot(cwd);
    const confirmed = resolveEffectiveStateUnlocked(cwd, nowMs, reviewSubjectFor, { risk, branchNextAction });
    if (JSON.stringify(authority)
      === JSON.stringify(authoritySourceHashes(confirmed.source_hashes))) {
      return { state: confirmed, reviewSubjectFor };
    }
    authority = authoritySourceHashes(confirmed.source_hashes);
  }
  throw new StateResolutionUnstableError();
}

export function buildStateSnapshotFromEffectiveState(
  state: EffectiveState,
  cwd = process.cwd(),
  nowMs = Date.now(),
): StateSnapshot {
  return projectStateSnapshot(state, collectStateSnapshotFacts(cwd, nowMs));
}

export function buildStateSnapshot(
  cwd = process.cwd(),
  nowMs = Date.now(),
): StateSnapshot {
  const state = resolveEffectiveStateReadOnly(cwd, nowMs, {
    targetPaths: [],
    operationKind: 'inspect',
  });
  return buildStateSnapshotFromEffectiveState(state, cwd, nowMs);
}
