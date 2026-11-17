import { posix, win32 } from 'path';
import { CAPABILITY_SOURCE_MODES, type CapabilitySourceMode } from '../../core/capabilities/registry';
import { POLICY_ABSENT, POLICY_PATH, policyValue, type DecodedWorkflowPolicy, type PolicyPath } from '../../core/workflow/policy-schema';
import { readText } from './collect-state-inputs';
import { readWorkflowPolicyFile } from './policy-file';

/** A decoded policy with an object root, or null when the file is absent. */
export type WorkflowPolicy = DecodedWorkflowPolicy | null;

/**
 * The policy file read through the contained-path check of the state inputs.
 * `readWorkflowPolicyFile` owns the read and the decode; `readSource` lets a
 * state pass observe one read of the file.
 */
export function readWorkflowPolicyDocument(
  cwd: string,
  readSource = (path: string) => readText(cwd, path),
): DecodedWorkflowPolicy {
  return readWorkflowPolicyFile(cwd, readSource);
}

/** The state resolver's reader: it needs an object root and validates the fields it owns. */
export function readWorkflowPolicy(cwd: string, readSource = (path: string) => readText(cwd, path)): WorkflowPolicy {
  const policy = readWorkflowPolicyDocument(cwd, readSource);
  if (!policy.present) return null;
  if (!policy.rootIsObject) {
    throw new Error(`invalid workflow policy object: ${POLICY_PATH}`);
  }
  validateWorkflowPolicy(policy);
  return policy;
}

/** The resolver's field read: an absent file gives every field absent. */
function resolverValue(policy: WorkflowPolicy, path: PolicyPath): unknown {
  return policy === null ? POLICY_ABSENT : policyValue(policy, path);
}

export function policyPath(policy: WorkflowPolicy, path: PolicyPath, fallback: string, root = '.ai/harness'): string {
  const jqPath = `.${path}`;
  const value = resolverValue(policy, path);
  if (value === POLICY_ABSENT) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid workflow policy path ${jqPath}`);
  }
  const posixPolicyRoot = posix.resolve('/repo', root);
  const posixCandidate = posix.resolve('/repo', value);
  const win32PolicyRoot = win32.resolve('C:\\repo', root).toLowerCase();
  const win32Candidate = win32.resolve('C:\\repo', value).toLowerCase();
  const containedByBothPathGrammars =
    posixCandidate.startsWith(`${posixPolicyRoot}${posix.sep}`) &&
    win32Candidate.startsWith(`${win32PolicyRoot}${win32.sep}`);
  if (
    value.includes('\n') ||
    value.includes('\r') ||
    !value.startsWith(`${root}/`) ||
    !containedByBothPathGrammars
  ) {
    throw new Error(`unsafe workflow policy path ${jqPath}: ${value}`);
  }
  return value;
}

/** The edit guard writes failure records here and `summarize-failures` reads them. No policy override (#692). */
export const FAILURE_LOG_FILE = '.ai/harness/failures/latest.jsonl';

/** Repo-relative workflow paths that the policy may relocate. */
export interface HarnessPaths {
  readonly runsDir: string;
  readonly contextMap: string;
  /** Display text only; nothing reads or writes through it. */
  readonly researchDir: string;
}

/**
 * The one reader of the policy path fields. Each field stays inside its own
 * root. A missing field takes the default; a malformed or escaping one throws.
 */
export function resolveHarnessPaths(cwd: string): HarnessPaths {
  const policy = readWorkflowPolicy(cwd);
  return {
    runsDir: policyPath(policy, 'harness.runs_dir', '.ai/harness/runs'),
    contextMap: policyPath(policy, 'context.map_file', '.ai/context/context-map.json', '.ai/context'),
    researchDir: policyString(policy, 'tasks.research_dir', 'docs/researches'),
  };
}

function policyString(policy: WorkflowPolicy, path: PolicyPath, fallback: string): string {
  const jqPath = `.${path}`;
  const value = resolverValue(policy, path);
  if (value === POLICY_ABSENT) return fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`invalid workflow policy string ${jqPath}`);
  }
  return value.trim();
}

function validateWorkflowPolicy(policy: WorkflowPolicy): void {
  // Validate every policy field owned by this resolver eagerly. Otherwise a
  // malformed capability or planning field can evade validation on an
  // inspect/no-target call and still publish cache/version authority.
  policyString(policy, 'worktree_strategy.review_base', 'main');
  policyString(policy, 'worktree_strategy.merge_back.target', 'main');
  policyString(policy, 'worktree_strategy.base_branch', 'main');
  policyPath(
    policy,
    'planning.pending_orchestration_file',
    '.ai/harness/planning/pending.json',
  );
  capabilitySourceMode(policy);
}

/**
 * The single capability authority selector, mirroring
 * scripts/capability-resolver.ts. `registry` reads the JSON registry,
 * `archcontext` reads archcontext capability nodes; there is no dual-read and
 * no fallback in either direction, and an unknown value fails closed.
 */
export function capabilitySourceMode(policy: WorkflowPolicy): CapabilitySourceMode {
  const value = resolverValue(policy, 'context.capability_source');
  if (value === POLICY_ABSENT) return 'registry';
  if (typeof value === 'string' && (CAPABILITY_SOURCE_MODES as readonly string[]).includes(value)) {
    return value as CapabilitySourceMode;
  }
  throw new Error(
    `invalid workflow policy value .context.capability_source: ${String(value)}`,
  );
}

// An explicit `capability_source: "registry"` declares the registry: init
// writes that key with the registry at the constant path. A declared missing
// or invalid registry fails closed. Restore it through init or the capability
// commands, or repair its JSON explicitly. Workflow diagnostics do not repair
// registry contents. An absent selector means registry mode, undeclared.
export function policyDeclaresCapabilityRegistry(policy: WorkflowPolicy): boolean {
  return resolverValue(policy, 'context.capability_source') === 'registry';
}

export function policyReviewBase(policy: WorkflowPolicy): string {
  return policyString(
    policy,
    'worktree_strategy.review_base',
    policyString(
      policy,
      'worktree_strategy.merge_back.target',
      policyString(policy, 'worktree_strategy.base_branch', 'main'),
    ),
  );
}
