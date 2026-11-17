import { assertObservationPath, observationReaddirSync as readdirSync } from '../readonly-observation';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { existsSync } from 'fs';
import { join } from 'path';
import { buildReviewSubject, isImplementationSurfacePath, type ReviewSubject } from '../review/diff-fingerprint';
import {
  isCapabilityPathOutsideRepo,
  normalizeCapabilityPath,
  PROJECTION_MANIFEST_PATH,
  parseCapabilityRegistry,
  withProjectedModulePages,
  resolveCapabilityPaths,
  type CapabilityIdentity,
  type CapabilityPathMatch,
  type CapabilityPathResolution,
  type CapabilityRegistryDiagnostic,
  type CapabilityRegistryResolution,
  type CapabilityOwnership,
  type CapabilitySourceMode,
} from '../../core/capabilities/registry';
import { capabilityOwnershipBlocker, type CapabilityOwnershipBlocker } from '../../core/capabilities/ownership-blocker';
import {
  ARCHCONTEXT_IDENTITY_OWNERS,
  architecturePort,
  isArchitectureUnavailable,
  type ArchcontextOwnerLookup,
  type ArchcontextResolveCache,
  type ArchctxProviderOptions,
} from '../../core/architecture/contracts';
import { contentRevision, fileExists, readText, repoPath, safeRealpath, sourceHash } from './collect-state-inputs';
import { gitExecFileSync } from '../git/runner';
import { capabilitySourceMode, policyDeclaresCapabilityRegistry, policyReviewBase, readWorkflowPolicy, type WorkflowPolicy } from './state-policy';

const CAPABILITY_REGISTRY_PATH = '.ai/context/capabilities.json';
const CAPABILITY_NODES_DIR = '.archcontext/model/nodes';
const CAPABILITY_NODE_FILE = /\.ya?ml$/;
/** Sorted repo-relative node file paths; empty when the directory is absent. */
function archcontextNodePaths(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(repoPath(cwd, CAPABILITY_NODES_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((name) => CAPABILITY_NODE_FILE.test(name))
    .sort()
    .map((name) => `${CAPABILITY_NODES_DIR}/${name}`);
}

/**
 * Content hash of the selected capability authority. Registry mode keeps the
 * single-file hash byte-for-byte without a projection manifest; a manifest
 * owns the module pages, so it joins the revision. Archcontext mode folds the
 * sorted node files into one revision so any node edit still moves authority_revision.
 */
export function capabilityAuthorityHash(cwd: string, mode: CapabilitySourceMode, hashSource = (path: string) => sourceHash(cwd, path)): string {
  if (mode === 'registry') {
    const registry = hashSource(CAPABILITY_REGISTRY_PATH);
    if (!fileExists(cwd, PROJECTION_MANIFEST_PATH)) return registry;
    return contentRevision({ [CAPABILITY_REGISTRY_PATH]: registry, [PROJECTION_MANIFEST_PATH]: hashSource(PROJECTION_MANIFEST_PATH) });
  }
  const paths = archcontextNodePaths(cwd);
  if (paths.length === 0) return sha256Prefixed(`missing:${CAPABILITY_NODES_DIR}`);
  return contentRevision(Object.fromEntries(paths.map((path) => [path, hashSource(path)])));
}

/** State-input source paths for the selected capability authority. */
export function capabilityAuthoritySourcePaths(cwd: string, mode: CapabilitySourceMode): string[] {
  if (mode === 'registry') return fileExists(cwd, PROJECTION_MANIFEST_PATH) ? [CAPABILITY_REGISTRY_PATH, PROJECTION_MANIFEST_PATH] : [CAPABILITY_REGISTRY_PATH];
  const paths = archcontextNodePaths(cwd);
  return paths.length > 0 ? paths : [CAPABILITY_NODES_DIR];
}

export type CapabilityRegistryStatus = 'valid' | 'absent' | 'invalid';

export interface CapabilityResolution {
  readonly ids: readonly string[];
  readonly registryStatus: CapabilityRegistryStatus;
  /** One match per owned path. Empty when ownership failed. */
  readonly matches: readonly CapabilityPathMatch<CapabilityIdentity>[];
  /** Paths whose owner the authority answered as "none". Empty when ownership failed. */
  readonly unmappedPaths: readonly string[];
  readonly malformedEntryCount: number;
  readonly outOfRepoPathCount: number;
  /** The blocker, with its first diagnostic, when ownership failed. */
  readonly blocker: CapabilityOwnershipBlocker | null;
}

/** A valid registry takes its module pages from the projection manifest when one exists. */
export function loadRegistryAuthority(cwd: string, policy: WorkflowPolicy, readSource: (path: string) => string | null): CapabilityRegistryResolution {
  const text = readSource(CAPABILITY_REGISTRY_PATH);
  const resolution = parseCapabilityRegistry(text && text.length > 0 ? text : null, {
    declared: policyDeclaresCapabilityRegistry(policy),
    repoRoot: cwd,
  });
  return resolution.status === 'valid' ? withProjectedModulePages(resolution, readSource(PROJECTION_MANIFEST_PATH)).resolution : resolution;
}

// One resolve runs several unlocked passes. The archctx answer depends only on
// the node files and the queried paths, so a pass with the same inputs reuses a success.
let archcontextResolutionMemo: { key: string; resolution: CapabilityPathResolution<CapabilityIdentity> } | null = null;

/** Under `archcontext`, ArchContext owns path ownership; a failed resolve fails closed. */
function resolveArchcontextPaths(
  cwd: string,
  owners: ArchcontextOwnerLookup<CapabilityIdentity>,
  paths: readonly string[],
  readSource: (path: string) => string | null,
  options?: ArchctxProviderOptions,
  cache?: ArchcontextResolveCache,
): CapabilityPathResolution<CapabilityIdentity> {
  const ownership = architecturePort('ownership');
  // No provider: the ownership blocker names it. The registry is never a fallback.
  if (isArchitectureUnavailable(ownership)) {
    return { status: 'unavailable', capabilityIds: [], matches: [], unmappedPaths: [], diagnostics: [{ code: 'ARCHCONTEXT_RESOLVE_UNAVAILABLE', path: CAPABILITY_NODES_DIR, message: ownership.message }] };
  }
  const nodes = archcontextNodePaths(cwd).map((path) => [path, readSource(path)]);
  // The queries carry each path's directory state, which changes what archctx answers.
  const key = sha256Prefixed(JSON.stringify([safeRealpath(cwd), nodes, paths, ownership.resolveQueries(cwd, paths)]));
  // Scoped transport options can select another environment or deadline.
  // Only ordinary state passes share the default transport's memo.
  if (!options && archcontextResolutionMemo?.key === key) return archcontextResolutionMemo.resolution;
  try {
    const resolution = ownership.resolvePaths(cwd, owners, paths, options, cache);
    // An unavailable answer is not memoized: a later pass outside observation computes it.
    if (!options && resolution.status !== 'unavailable') archcontextResolutionMemo = { key, resolution };
    return resolution;
  } catch (error) {
    // A process failure is not memoized: the next resolve tries archctx again.
    return { status: 'unavailable', capabilityIds: [], matches: [], unmappedPaths: [], diagnostics: [ownership.resolveFailure(error)] };
  }
}

/** Resolve one union, then keep each subject's owners and path errors separate. */
export function capabilityIdsForPathGroups(
  cwd: string,
  groups: readonly (readonly string[])[],
  policy: WorkflowPolicy,
  readSource = (path: string) => readText(cwd, path),
  select: (paths: readonly string[]) => readonly string[] = (paths) => paths,
  options?: ArchctxProviderOptions,
  cache?: ArchcontextResolveCache,
): CapabilityResolution[] {
  const mode = capabilitySourceMode(policy);
  const inputs = groups.map((paths) => {
    const inRepoPaths = paths.filter((path) => !isCapabilityPathOutsideRepo(path, cwd));
    return { inRepoPaths, outOfRepoPathCount: paths.length - inRepoPaths.length };
  });
  const invalid = (diagnostics: readonly CapabilityRegistryDiagnostic[], outOfRepoPathCount: number): CapabilityResolution => ({
    ids: [], registryStatus: 'invalid', matches: [], unmappedPaths: [],
    malformedEntryCount: new Set(diagnostics.map((entry) => /^capabilities\[(\d+)\]/.exec(entry.path)?.[1]).filter(Boolean)).size,
    outOfRepoPathCount,
    blocker: capabilityOwnershipBlocker(diagnostics[0]!, mode),
  });
  const registry = mode === 'registry' ? loadRegistryAuthority(cwd, policy, readSource) : null;
  if (registry?.status === 'absent') {
    return inputs.map(({ outOfRepoPathCount }) => ({
      ids: [], registryStatus: 'absent', matches: [], unmappedPaths: [], malformedEntryCount: 0, outOfRepoPathCount, blocker: null,
    }));
  }
  const authorityErrors = registry?.status === 'invalid' ? registry.diagnostics
    : mode === 'archcontext' && archcontextNodePaths(cwd).length === 0
      ? [{ code: 'REGISTRY_MISSING' as const, path: CAPABILITY_NODES_DIR, message: `capability nodes are missing: ${CAPABILITY_NODES_DIR}` }]
      : [];
  if (authorityErrors.length > 0) return inputs.map(({ outOfRepoPathCount }) => invalid(authorityErrors, outOfRepoPathCount));

  const subjects = inputs.map(({ inRepoPaths, outOfRepoPathCount }) => {
    const paths = new Set<string>();
    const diagnostics: CapabilityRegistryDiagnostic[] = [];
    for (const path of select(inRepoPaths)) {
      try { paths.add(normalizeCapabilityPath(path, cwd)); }
      catch (error) { diagnostics.push({ code: 'INVALID_PATH', path: 'path', message: (error as Error).message }); }
    }
    return { paths, diagnostics, outOfRepoPathCount };
  });
  const union = Array.from(new Set(subjects.flatMap(({ paths }) => [...paths]))).sort();
  const resolution: CapabilityPathResolution<CapabilityIdentity> = registry?.status === 'valid'
    ? resolveCapabilityPaths(registry.registry, union, { repoRoot: cwd })
    : union.length === 0
      ? { status: 'valid', capabilityIds: [], matches: [], unmappedPaths: [], diagnostics: [] }
      : resolveArchcontextPaths(cwd, ARCHCONTEXT_IDENTITY_OWNERS, union, readSource, options, cache);
  return subjects.map(({ paths, diagnostics: pathErrors, outOfRepoPathCount }): CapabilityResolution => {
    const diagnostics = [...pathErrors, ...resolution.diagnostics.filter((entry) => {
      // Empty subjects did not need archctx before this union query either.
      if (paths.size === 0) return false;
      return mode !== 'archcontext' || !['AMBIGUOUS_MATCH', 'ARCHCONTEXT_OWNER_UNKNOWN'].includes(entry.code)
        || paths.has(entry.path);
    })];
    if (diagnostics.length > 0) return invalid(diagnostics, outOfRepoPathCount);
    const matches = resolution.matches.filter((match) => paths.has(match.filePath));
    return {
      ids: Array.from(new Set(matches.map((match) => match.capability.id))).sort(),
      registryStatus: 'valid', matches,
      unmappedPaths: resolution.unmappedPaths.filter((path) => paths.has(path)),
      malformedEntryCount: 0, outOfRepoPathCount, blocker: null,
    };
  });
}

function capabilityIdsForPaths(
  cwd: string,
  paths: readonly string[],
  policy: WorkflowPolicy,
  readSource?: (path: string) => string | null,
  select?: (paths: readonly string[]) => readonly string[],
  options?: ArchctxProviderOptions,
  cache?: ArchcontextResolveCache,
): CapabilityResolution {
  return capabilityIdsForPathGroups(cwd, [paths], policy, readSource, select, options, cache)[0]!;
}

function git(repoRoot: string, args: readonly string[]): string {
  return gitExecFileSync(['-C', repoRoot, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
}

/** Keep branch review history; use the last projection checkpoint on the base. */
function owedCapabilityBase(repoRoot: string, reviewBase: string, headRev?: string): {
  readonly reviewBase: string;
  readonly manifestChange: string | null;
} {
  assertObservationPath(join(repoRoot, PROJECTION_MANIFEST_PATH));
  if (existsSync(join(repoRoot, PROJECTION_MANIFEST_PATH))) {
    const head = headRev ?? git(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (reviewBase === head || git(repoRoot, ['merge-base', reviewBase, head]).trim() === head) {
      const checkpoint = git(repoRoot, ['log', '-1', '--format=%H', 'HEAD', '--', PROJECTION_MANIFEST_PATH]).trim();
      if (checkpoint) return { reviewBase: checkpoint, manifestChange: checkpoint };
    }
  }
  return { reviewBase, manifestChange: null };
}

/** The owed subject is independent of the subject used for risk and review. */
export function owedOwnershipSubject(cwd: string, reviewSubject: ReviewSubject): ReviewSubject {
  if (reviewSubject.status !== 'ok') return reviewSubject;
  const base = owedCapabilityBase(cwd, reviewSubject.target_rev, reviewSubject.head_rev);
  return base.reviewBase === reviewSubject.target_rev
    ? reviewSubject
    : buildReviewSubject(cwd, { targetRef: base.reviewBase });
}

/** Groups the resolved owners by capability. Null when ownership was not computed. */
export function capabilityOwnershipFrom(
  resolution: CapabilityResolution | null,
  declared: boolean,
  reviewBase: string | null,
): CapabilityOwnership | null {
  if (!resolution || declared || resolution.registryStatus !== 'valid') return null;
  const byId = new Map<string, { module_document: string | null; paths: string[] }>();
  for (const match of resolution.matches) {
    const entry = byId.get(match.capability.id) ?? { module_document: match.capability.architecture_module, paths: [] };
    entry.paths.push(match.filePath);
    byId.set(match.capability.id, entry);
  }
  return {
    review_base: reviewBase,
    capability_ids: resolution.ids,
    capabilities: resolution.ids.map((id) => ({ id, ...byId.get(id)! })),
    unowned_paths: resolution.unmappedPaths,
  };
}

/**
 * Ownership against `targetRef`, or the policy review base when omitted.
 * A checkout not ahead of that base uses its last manifest checkpoint. The
 * returned review_base keeps the policy target so notice callers can filter
 * these paths against its merge-base. It reads the same authority and runs
 * the same ownership resolution as `state resolve`, without the state
 * lock, the cache or the version store. Null means the repository declares no
 * capability registry, so nothing is owned. It throws when the review subject
 * or ownership is unavailable.
 */
export function resolveCapabilityOwnership(cwd: string, targetRef?: string, options?: ArchctxProviderOptions): CapabilityOwnership | null {
  const policy = readWorkflowPolicy(cwd);
  const reviewSubject = availableReviewSubject(cwd, targetRef ?? policyReviewBase(policy));
  const owedSubject = owedOwnershipSubject(cwd, reviewSubject);
  if (owedSubject.status !== 'ok') throw new Error(`owed subject is unavailable: ${owedSubject.reason ?? 'unknown reason'}`);
  const resolution = capabilityIdsForPaths(cwd, owedSubject.paths.filter(isImplementationSurfacePath), policy, undefined, undefined, options);
  if (resolution.blocker) throw new CapabilityOwnershipError(resolution.blocker);
  if (resolution.registryStatus === 'absent') return null;
  return capabilityOwnershipFrom(resolution, false, reviewSubject.target_rev)!;
}

/** Ownership was not computed. The blocker keeps its code, so a reader classifies the cause by type, not by text. */
export class CapabilityOwnershipError extends Error {
  constructor(readonly blocker: CapabilityOwnershipBlocker) {
    super(`${blocker.key} ${blocker.code}: ${blocker.message}; fix: ${blocker.fix}`);
    this.name = 'CapabilityOwnershipError';
  }
}

/**
 * The policy review base revision that `resolveCapabilityOwnership` measures
 * against. It reads Git only and runs no archctx. It throws when the review
 * subject is unavailable.
 */
export function resolveReviewBase(cwd: string): string {
  return availableReviewSubject(cwd, policyReviewBase(readWorkflowPolicy(cwd))).target_rev;
}

function availableReviewSubject(cwd: string, targetRef: string): ReviewSubject {
  const reviewSubject = buildReviewSubject(cwd, { targetRef });
  if (reviewSubject.status !== 'ok') {
    throw new Error(`review subject is unavailable: ${reviewSubject.reason ?? 'unknown reason'}`);
  }
  return reviewSubject;
}

export interface CapabilityPathOwner {
  readonly id: string;
  readonly module_document: string | null;
}

/**
 * The owning capability of each owned repository-relative path. It reads the
 * same authority as `state resolve`, but it builds no review subject, takes no
 * state lock and writes nothing. A path is absent from the map when it is not
 * an implementation surface or has no owner; the map is empty when the
 * repository declares no registry. One call resolves the whole batch, so an
 * archcontext repository starts at most one `archctx resolve`, and none when
 * the per-HEAD resolve cache already answers every path. `select` narrows the
 * batch after the authority loads and before ownership resolves, so a caller
 * pays for its own filter only when a registry exists. It throws when
 * ownership is unavailable.
 */
export function capabilityOwnersForPaths(
  cwd: string,
  paths: readonly string[],
  select?: (surfaces: readonly string[]) => readonly string[],
): ReadonlyMap<string, CapabilityPathOwner> {
  const owners = new Map<string, CapabilityPathOwner>();
  const surfaces = paths.filter(isImplementationSurfacePath);
  if (surfaces.length === 0) return owners;
  const ownership = architecturePort('ownership');
  const cache = isArchitectureUnavailable(ownership) ? undefined : ownership.resolveCache(cwd);
  const resolution = capabilityIdsForPaths(cwd, surfaces, readWorkflowPolicy(cwd), undefined, select, undefined, cache);
  if (resolution.blocker) throw new CapabilityOwnershipError(resolution.blocker);
  for (const match of resolution.matches) {
    owners.set(match.filePath, { id: match.capability.id, module_document: match.capability.architecture_module });
  }
  return owners;
}
