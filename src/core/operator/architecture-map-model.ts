// The contract of the architecture base map and its layers (PRD G11, G22): the
// wire types, their reason codes, and the pure projections from an archctx
// answer to that wire form. The strict decoder and the map projection stay in
// `architecture-map.ts`; this leaf never imports it.

import type { RefImpactV1 } from 'archctx-contracts';
import { PULL_REQUEST_FILES_REASONS } from './pull-request-files';
import { TESTS_UNAVAILABLE_REASONS } from './tests';

export const OPERATOR_ARCHITECTURE_MAP_SCHEMA = 'repo-harness.architecture-map.v7' as const;
export const OPERATOR_ARCHITECTURE_MAP_ROUTE = /^\/api\/v1\/repositories\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/architecture\/map$/u;

/**
 * Why a repository's map cannot be served. Each maps to one HTTP status in the route.
 * `model_unavailable`: the committed model read failed with no archctx error code
 * (an archctx refusal is an `ArchitectureMapUnavailableV1` with archctx's codes);
 * `architecture_map_failed`: the map process read the model, then failed;
 * `architecture_map_timeout`: the map process passed its deadline;
 * `architecture_map_process_failed`: the map process did not start or gave no result.
 */
export const ARCHITECTURE_MAP_UNAVAILABLE_REASONS = [
  'architecture_map_pending',
  'registry_unavailable',
  'repository_not_found',
  'model_unavailable',
  'architecture_map_invalid',
  'architecture_map_failed',
  'architecture_map_timeout',
  'architecture_map_process_failed',
] as const;
export type ArchitectureMapUnavailableReason = typeof ARCHITECTURE_MAP_UNAVAILABLE_REASONS[number];
/** The reasons that the map process itself reports; the collector refuses any other. */
export const ARCHITECTURE_MAP_WORKER_REASONS = ['repository_not_found', 'model_unavailable', 'architecture_map_failed'] as const;
export type ArchitectureMapWorkerReason = typeof ARCHITECTURE_MAP_WORKER_REASONS[number];
/** A repository without a map: a named reason, or archctx's refusal of the committed model read. */
export type ArchitectureMapUnavailableV1 =
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapUnavailableReason }
  | ArchctxRefusalV1;

/** Why line counts are missing while the model itself is served. */
export const ARCHITECTURE_MAP_SIZE_REASONS = ['model_worktree_dirty', 'checkout_changed', 'ownership_unavailable', 'git_read_failed'] as const;
export type ArchitectureMapSizeReason = typeof ARCHITECTURE_MAP_SIZE_REASONS[number];

/**
 * Why import counts are missing. The collector never builds a CodeGraph index.
 * The index covers the working tree, so it describes the commit only while the
 * whole tree is clean: `code_facts_worktree_dirty` otherwise.
 */
export const ARCHITECTURE_MAP_DEPENDENCY_REASONS = ['model_worktree_dirty', 'checkout_changed', 'code_facts_worktree_dirty', 'code_facts_unavailable', 'code_facts_incomplete', 'code_facts_other_commit', 'dependencies_unavailable'] as const;
export type ArchitectureMapDependencyReason = typeof ARCHITECTURE_MAP_DEPENDENCY_REASONS[number];

/**
 * Changed paths, owners, dependents and the model delta read only commits and
 * need no clean checkout. `flow_steps` uses the worktree CodeGraph index;
 * archctx reports unknown when its facts are missing or do not match the commit.
 * A first-parent history that starts after midnight has no base commit;
 * `archctx_failed`: archctx did not run, or its answer broke its contract or the map's grammar;
 * `path_not_public`: archctx's answer is valid, but a path in it fails the public-path guard.
 */
export const ARCHITECTURE_CHANGE_REASONS = ['git_read_failed', 'history_starts_today', 'archctx_failed', 'path_not_public'] as const;
export type ArchitectureChangeReason = typeof ARCHITECTURE_CHANGE_REASONS[number];
/** Each violation check reads the worktree model and the CodeGraph index, as import counts do. */
export const ARCHITECTURE_VIOLATION_REASONS = [...ARCHITECTURE_MAP_DEPENDENCY_REASONS, 'archctx_failed'] as const;
export type ArchitectureViolationReason = typeof ARCHITECTURE_VIOLATION_REASONS[number];
/** The tests collector's own reasons, a projection gap, or a projection that names a capability the map does not have. */
export const ARCHITECTURE_TEST_REASONS = [...TESTS_UNAVAILABLE_REASONS, 'projection_missing', 'projection_invalid', 'tests_model_mismatch'] as const;
export type ArchitectureTestReason = typeof ARCHITECTURE_TEST_REASONS[number];
/**
 * The Dev Activity cache has not collected yet, or has no complete GitHub read
 * for the repository. `archctx impact --paths-from` reads the worktree model,
 * so the model must be clean at the map commit.
 */
export const ARCHITECTURE_PR_LAYER_REASONS = ['model_worktree_dirty', 'checkout_changed', 'git_read_failed', 'dev_activity_pending', 'dev_activity_unavailable'] as const;
export type ArchitecturePullRequestsReason = typeof ARCHITECTURE_PR_LAYER_REASONS[number];
/** One open PR without impact: gh gave no head commit or no complete file list, archctx failed, or a path in its valid answer fails the public-path guard. */
export const ARCHITECTURE_PR_REASONS = ['head_missing', ...PULL_REQUEST_FILES_REASONS, 'archctx_failed', 'path_not_public'] as const;
export type ArchitecturePullRequestReason = typeof ARCHITECTURE_PR_REASONS[number];
/** Why the map has no layer order: the model declares no ordered `model.layers`. */
export const ARCHITECTURE_LAYER_ORDER_REASONS = ['model_layers_undeclared'] as const;
export type ArchitectureLayerOrderReason = typeof ARCHITECTURE_LAYER_ORDER_REASONS[number];
/**
 * Why imports against the layer order are not shown: a violation check reason;
 * the model declares no ordered `model.layers`; the committed model has no
 * `layer-direction` constraint; or archctx found an import endpoint that no
 * layered node owns, so its answer is undetermined.
 */
export const ARCHITECTURE_LAYER_DIRECTION_REASONS = [
  ...ARCHITECTURE_VIOLATION_REASONS, 'model_layers_undeclared', 'layer_direction_undeclared', 'layer_endpoint_unclassified',
] as const;
export type ArchitectureLayerDirectionReason = typeof ARCHITECTURE_LAYER_DIRECTION_REASONS[number];
/**
 * The archctx reads behind each violation part, as the map collector runs them.
 * The console shows the same arguments as the command that lists a finding;
 * archctx's answer names its own remedy.
 */
export const ARCHITECTURE_VIOLATION_READS = {
  debt: ['debt', '--json'],
  flows: ['flows', 'check', '--no-sync', '--json'],
  anchors: ['docs', 'anchors', '--json'],
  dependencies: ['deps', '--json'],
  layer_direction: ['constraints', 'check', '--json'],
} as const satisfies Record<keyof ArchitectureViolationsLayerV1, readonly string[]>;

/** The shell command for one violation part's read. */
export function architectureViolationCommand(part: keyof ArchitectureViolationsLayerV1): string {
  return ['archctx', ...ARCHITECTURE_VIOLATION_READS[part]].join(' ');
}

/** The debt kinds that `archctx debt` reports itself; it defers dependency, flow and practice checks. A stale anchor or a machine rule may name no path. */
export const ARCHITECTURE_DEBT_KINDS = ['unowned-path', 'ambiguous-owner', 'stale-anchor', 'state-machine-rule', 'state-machine-stale'] as const;
export type ArchitectureDebtKind = typeof ARCHITECTURE_DEBT_KINDS[number];

export interface ArchitectureMapNodeV1 {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  /** The model's layer name. With a layer order, the map places the node in that layer's band. */
  readonly layer: string | null;
  readonly parent: string | null;
  readonly summary: string;
  /** The capability profile's domain from the same export; non-null exactly for a capability. */
  readonly domain: string | null;
  /** The model's `namespace`; non-null exactly for a namespace node. */
  readonly namespace: { readonly type: ArchitectureNamespaceType } | null;
  /** The model's `mount`; non-null exactly for a mount node. A source or target that the prose guard would change is null. */
  readonly mount: { readonly source: string | null; readonly target: string | null; readonly mode: 'ro' | 'rw'; readonly order: number } | null;
}
/** The namespace types of `archcontext.node/v2`. */
export const ARCHITECTURE_NAMESPACE_TYPES = ['host', 'container', 'pod', 'kubernetes', 'pid', 'mount', 'net', 'user'] as const;
export type ArchitectureNamespaceType = typeof ARCHITECTURE_NAMESPACE_TYPES[number];

export interface ArchitectureMapRelationV1 {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly intent: string;
  /** The model's free-text `protocol`, masked like model prose. */
  readonly protocol: string | null;
}

/** A node's tracked text files and their lines, its own and its descendants'. A node that owns no file is absent. */
export interface ArchitectureMapSizeV1 { readonly id: string; readonly files: number; readonly lines: number }
/** Imports from one capability into another, from `archctx deps`. */
export interface ArchitectureMapImportV1 { readonly source: string; readonly target: string; readonly imports: number }
/** File imports from `source` into `target` that `archctx constraints check` reports against the layer order: `target_layer` is above `source_layer`. */
export interface ArchitectureLayerViolationV1 {
  readonly source: string;
  readonly target: string;
  readonly source_layer: string;
  readonly target_layer: string;
  readonly imports: number;
}

export type ArchitectureMapSizesV1 =
  | { readonly state: 'ok'; readonly nodes: readonly ArchitectureMapSizeV1[] }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapSizeReason };
export type ArchitectureMapDependenciesV1 =
  | { readonly state: 'ok'; readonly edges: readonly ArchitectureMapImportV1[] }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapDependencyReason };

export type Gap<Reason extends string> = { readonly state: 'unavailable'; readonly reason: Reason };
export type Section<Fields, Reason extends string> = ({ readonly state: 'ok' } & Fields) | Gap<Reason>;

/** The model's `model.layers` from `archctx export native`, top layer first. archctx checks that it declares every node layer. */
export type ArchitectureLayerOrderV1 = Section<{ readonly layers: readonly string[] }, ArchitectureLayerOrderReason>;

/**
 * An archctx error envelope. archctx owns its error and reason codes; the map
 * carries them as opaque tokens and checks only their shape.
 */
export interface ArchctxRefusalV1 {
  readonly state: 'unavailable';
  readonly reason: 'archctx_error';
  /** The archctx error code, for example `AC_SCHEMA_INVALID`. */
  readonly code: string;
  /** The archctx reason code, a kebab-case token; null when archctx gives none. */
  readonly reason_code: string | null;
}
export const ARCHCTX_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
export const ARCHCTX_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** The refusal of an archctx error envelope; null when its codes do not have the archctx shape. */
export function archctxRefusal(code: unknown, reasonCode: unknown): ArchctxRefusalV1 | null {
  if (typeof code !== 'string' || !ARCHCTX_CODE.test(code)) return null;
  if (reasonCode !== undefined && reasonCode !== null && (typeof reasonCode !== 'string' || !ARCHCTX_TOKEN.test(reasonCode))) return null;
  return { state: 'unavailable', reason: 'archctx_error', code, reason_code: reasonCode ?? null };
}

/** The map route's refusal body: the typed operator error, and archctx's codes when its code is `archctx_error`. */
export interface ArchitectureMapRefusalV1 {
  readonly error: { readonly code: string; readonly message: string; readonly next_action: string };
  readonly archctx?: { readonly code: string; readonly reason_code: string | null };
}

/** One changed path from `archctx impact`. Its reason codes say why a line count is null or an owner is contested. */
export interface ArchitectureImpactPathV1 {
  readonly path: string;
  readonly added: number | null;
  readonly deleted: number | null;
  /** The owning nodes at the base and the head; more than one when the owner moved or is contested, none when unowned. */
  readonly owners: readonly string[];
  readonly reason_codes: readonly string[];
}
/** A flow step that the change reaches, with archctx's reason codes for it. */
export interface ArchitectureFlowStepV1 { readonly flow: string; readonly step: string; readonly outcome: string | null; readonly reason_codes: readonly string[] }
/** Parts of the answer that archctx cut at its own limits; a cut part is a lower bound. */
export interface ArchitectureImpactTruncationV1 {
  readonly paths: boolean;
  readonly nodes: boolean;
  readonly relations: boolean;
  readonly flow_steps: boolean;
  readonly dependents: boolean;
  readonly model: boolean;
}
/** One `archctx impact` answer as the map carries it. */
export interface ArchitectureImpactV1 {
  readonly paths: readonly ArchitectureImpactPathV1[];
  readonly unowned_paths: readonly string[];
  /** Each owner of a changed path and its changed path count. */
  readonly nodes: readonly { readonly id: string; readonly files: number }[];
  /** Nodes that reach a changed node through `calls` or `depends-on` relations of the head model, with the relations of one shortest path. */
  readonly dependents: readonly { readonly id: string; readonly touched: string; readonly relations: readonly string[] }[];
  readonly dependency_coverage: 'complete' | 'partial';
  /** `unknown` with archctx's reason codes when its code facts cannot tie a flow step to the change. */
  readonly flow_steps: { readonly status: 'known' | 'unknown'; readonly reason_codes: readonly string[]; readonly items: readonly ArchitectureFlowStepV1[] | null };
  readonly truncated: ArchitectureImpactTruncationV1;
}
/** One model entity whose committed record differs between the base and the map commit, with the fields that differ. */
export interface ArchitectureModelChangeV1 {
  readonly kind: 'nodes' | 'relations' | 'flows';
  readonly id: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly fields: readonly string[];
}
export type ArchitectureChangesLayerV1 = Section<{
  /** Local midnight of the collector host, as an instant. */
  readonly since: string;
  /** The newest first-parent commit before `since`; archctx compares it with the map commit. */
  readonly base: string;
  /** The first-parent commits after `base`, newest first, with the owners that `paths` gives to the paths each commit changed. */
  readonly commits: readonly ArchitectureChangeCommitV1[];
  readonly model: readonly ArchitectureModelChangeV1[];
} & ArchitectureImpactV1, ArchitectureChangeReason> | ArchctxRefusalV1;

/**
 * One commit of today's window. `nodes` joins the commit's changed paths with
 * the layer's `paths`: a path that changed back inside the window is not in
 * `paths`, and a cut `paths` makes `nodes` a lower bound.
 */
export interface ArchitectureChangeCommitV1 { readonly sha: string; readonly subject: string; readonly nodes: readonly string[] }

/** The map's form of an `archctx impact` answer. Field names change; no value is derived. */
export function architectureImpact(report: RefImpactV1): ArchitectureImpactV1 {
  const { touchedFlowSteps: steps, truncated } = report;
  return {
    paths: report.changedPaths.map(entry => ({ path: entry.path, added: entry.added, deleted: entry.deleted, owners: entry.owners, reason_codes: entry.reasonCodes })),
    unowned_paths: report.unownedPaths,
    nodes: report.touchedNodes.map(entry => ({ id: entry.nodeId, files: entry.pathCount })),
    dependents: report.dependents.map(entry => ({ id: entry.nodeId, touched: entry.touchedNodeId, relations: entry.relationIds })),
    dependency_coverage: report.dependencyCoverage.status,
    flow_steps: {
      status: steps.status, reason_codes: steps.reasonCodes,
      items: steps.items === null ? null : steps.items.map(item => ({ flow: item.flowId, step: item.stepId, outcome: item.outcomeId, reason_codes: item.reasonCodes })),
    },
    truncated: {
      paths: truncated.changedPaths, nodes: truncated.touchedNodes, relations: truncated.relations,
      flow_steps: truncated.flowSteps, dependents: truncated.dependents, model: truncated.modelDelta,
    },
  };
}

export interface ArchitectureDebtItemV1 { readonly kind: ArchitectureDebtKind; readonly nodes: readonly string[]; readonly paths: readonly string[] }

/** The evidence of a flow step: archctx's selector key, an entrypoint symbol and a sink of one model node. */
export interface ArchitectureFlowSelectorV1 { readonly entrypoint: string; readonly source_symbol: string; readonly sink: string }
/** archctx's proof status for one selector that a flow step names, for example `proven` or `no-direct-call`. */
export interface ArchitectureFlowProofV1 extends ArchitectureFlowSelectorV1 {
  readonly status: string;
  readonly call_sites: readonly { readonly path: string; readonly line: number | null }[];
}
/** `archctx flows check --no-sync`: selector proof counts, each flow step selector's status, and the capabilities whose P2 flow proof archctx calls unprovable. */
export interface ArchitectureFlowProofsV1 {
  readonly selectors: number;
  readonly proven: number;
  readonly unproven: number;
  /** Unproven selectors that a required-flow step names. */
  readonly used_unproven: number;
  readonly unprovable: readonly { readonly id: string; readonly diagnostics: number }[];
  /** The selectors that the map's flow steps name, by archctx's selector key. */
  readonly evidence: readonly ArchitectureFlowProofV1[];
}

/** One message of a flow: participant ids, the model's label and the step's evidence selector. */
export interface ArchitectureMapFlowStepV1 {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly evidence: ArchitectureFlowSelectorV1;
}
export interface ArchitectureMapFlowOutcomeV1 {
  readonly id: string;
  readonly kind: 'success' | 'error';
  readonly label: string;
  readonly steps: readonly ArchitectureMapFlowStepV1[];
  readonly terminal: { readonly participant: string; readonly label: string };
}
/** One flow of the committed model (`archcontext.flow/v1`); free text is masked like model prose. */
export type ArchitectureMapFlowV1 = { readonly id: string; readonly capability: string; readonly name: string } & (
  | {
    readonly applicability: 'required';
    readonly participants: readonly { readonly id: string; readonly node: string }[];
    readonly steps: readonly ArchitectureMapFlowStepV1[];
    readonly outcomes: readonly ArchitectureMapFlowOutcomeV1[];
  }
  | { readonly applicability: 'not-applicable'; readonly rationale: string }
);
/**
 * The code that one model node declares for a flow step selector in its
 * `source.entrypoints`. A path is null when the public-path guard refuses it.
 */
export interface ArchitectureFlowEvidenceV1 extends ArchitectureFlowSelectorV1 {
  readonly node: string;
  readonly source_path: string | null;
  readonly sink_path: string | null;
  readonly sink_symbol: string;
}

/** archctx's selector key, as one string. */
export function flowSelectorKey(selector: ArchitectureFlowSelectorV1): string {
  return `${selector.entrypoint}\0${selector.source_symbol}\0${selector.sink}`;
}

/** Every step of a required flow, the outcome steps after the main steps; `outcome` is null for a main step. */
export function flowSteps(flow: ArchitectureMapFlowV1): { readonly outcome: string | null; readonly step: ArchitectureMapFlowStepV1 }[] {
  if (flow.applicability !== 'required') return [];
  return [...flow.steps.map(step => ({ outcome: null, step })), ...flow.outcomes.flatMap(outcome => outcome.steps.map(step => ({ outcome: outcome.id, step })))];
}
/**
 * One stale citation from `archctx docs anchors`. `path` and `line` come from a
 * document origin; a path that the public-path guard refuses is null.
 */
export interface ArchitectureAnchorFindingV1 {
  /** archctx's finding kind, for example `line-moved`. */
  readonly kind: string;
  readonly origin: 'document' | 'node-summary' | 'node-responsibility';
  readonly path: string | null;
  readonly line: number | null;
  /** The citation text, masked like model prose. */
  readonly citation: string;
}
export interface ArchitectureViolationsLayerV1 {
  /** `archctx debt`: unowned and contested paths, stale model anchors. */
  readonly debt: Section<{ readonly items: readonly ArchitectureDebtItemV1[] }, ArchitectureViolationReason>;
  /** Flow proofs from the existing CodeGraph index; the check writes no index. */
  readonly flows: Section<ArchitectureFlowProofsV1, ArchitectureViolationReason> | ArchctxRefusalV1;
  /** `archctx docs anchors`: citations in human-written module docs that no longer match the code. */
  readonly anchors: Section<{ readonly citations: number; readonly nodes: readonly { readonly id: string; readonly findings: readonly ArchitectureAnchorFindingV1[] }[] }, ArchitectureViolationReason>;
  /** `archctx deps` rows that archctx marks undeclared: imports with no model relation behind them. */
  readonly dependencies: Section<{ readonly edges: readonly ArchitectureMapImportV1[] }, ArchitectureViolationReason>;
  /** `archctx constraints check` for the committed `layer-direction` constraints: the import edges it read, and the node pairs that import against the layer order. */
  readonly layer_direction: Section<{ readonly imports: number; readonly edges: readonly ArchitectureLayerViolationV1[] }, ArchitectureLayerDirectionReason> | ArchctxRefusalV1;
}

/** One architecture decision record from `archctx export native`; free text is masked like model prose. */
export interface ArchitectureDecisionV1 {
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  readonly decided_at: string | null;
  /** Model nodes the decision applies to; archctx refuses an export that names an unknown node. */
  readonly applies_to: readonly string[];
  readonly supersedes: readonly string[];
  readonly path: string;
}
/** The decisions come from the same export as the model, so they have no gap of their own. */
export interface ArchitectureDecisionsLayerV1 { readonly state: 'ok'; readonly items: readonly ArchitectureDecisionV1[] }

/** Test files of one capability by their result in the daily run. `no_result`: the run has no report for the file. */
export interface ArchitectureTestCoverageV1 {
  readonly id: string;
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly no_result: number;
}
export type ArchitectureTestsLayerV1 = Section<{
  readonly run: { readonly id: number; readonly head_sha: string; readonly created_at: string };
  readonly results: 'ok' | 'junit_missing' | 'junit_invalid';
  readonly capabilities: readonly ArchitectureTestCoverageV1[];
}, ArchitectureTestReason>;

/**
 * The `archctx impact --paths-from` answer for one open PR's changed files at
 * its head, with owners from the map commit's model. A path list has no line
 * counts and no model change.
 */
export interface ArchitecturePullRequestImpactV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The head commit gh reported; the files are the PR's diff at this head. */
  readonly head_sha: string | null;
  readonly impact: Section<ArchitectureImpactV1, ArchitecturePullRequestReason> | ArchctxRefusalV1;
}
export type ArchitecturePullRequestsLayerV1 = Section<{
  /** When the Dev Activity collector read the PRs from GitHub. */
  readonly observed_at: string;
  readonly pull_requests: readonly ArchitecturePullRequestImpactV1[];
}, ArchitecturePullRequestsReason>;

export interface ArchitectureMapLayersV1 {
  readonly changes: ArchitectureChangesLayerV1;
  readonly violations: ArchitectureViolationsLayerV1;
  readonly pull_requests: ArchitecturePullRequestsLayerV1;
  readonly tests: ArchitectureTestsLayerV1;
  readonly decisions: ArchitectureDecisionsLayerV1;
}

export interface ArchitectureMapV1 {
  readonly schema_version: typeof OPERATOR_ARCHITECTURE_MAP_SCHEMA;
  readonly repository_id: string;
  readonly commit: string;
  /** The branch that HEAD names when the cycle starts; null for a detached HEAD. */
  readonly head_ref: string | null;
  /** The archctx package version that served every archctx read of the cycle. */
  readonly archctx_version: string;
  readonly collected_at: string;
  readonly nodes: readonly ArchitectureMapNodeV1[];
  readonly relations: readonly ArchitectureMapRelationV1[];
  /** The model's flows from the same `archctx export native` read. */
  readonly flows: readonly ArchitectureMapFlowV1[];
  /** The declared code of each flow step selector that exactly one node declares. */
  readonly flow_evidence: readonly ArchitectureFlowEvidenceV1[];
  readonly sizes: ArchitectureMapSizesV1;
  readonly dependencies: ArchitectureMapDependenciesV1;
  readonly layer_order: ArchitectureLayerOrderV1;
  readonly layers: ArchitectureMapLayersV1;
}
