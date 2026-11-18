// Public contract of the architecture base map and its layers (PRD G11, G22).
// The map collector reads the committed model, its capability domains and its
// decisions with `archctx export native`, the tracked text files of that commit with their line counts,
// their owners with `archctx resolve`, and the capability import counts with
// `archctx deps`. The layers come from the same cycle: `archctx impact` from the
// last commit before local midnight to the map commit with that window's commits
// from `git log`, `archctx debt`, `docs
// anchors`, `flows check --no-sync` and `constraints check`, `archctx impact
// --paths-from` for each open PR's changed files from the Dev Activity cache, and
// the tests collector's cache. The same export gives the model's flows and the
// code each flow step selector names. archctx owns ownership, impact, dependency, flow,
// decision, anchor, layer-order and layer-direction facts; this module only sums line counts along the model's `parent` chain and
// checks the shape. The strict decoder serves the server before it sends and the
// browser before it renders.

import { isPublicDevActivityText, isPublicRepoPath } from '../public-projections/public-text';
import { PULL_REQUEST_FILES_REASONS, type PullRequestFiles } from './pull-request-files';
import { isRecord } from '../evidence/is-record';
import type { TestsSnapshotV1, TestsUnavailableReason } from './tests';

import {
  ARCHCTX_CODE,
  ARCHCTX_TOKEN,
  ARCHITECTURE_CHANGE_REASONS,
  ARCHITECTURE_DEBT_KINDS,
  ARCHITECTURE_LAYER_DIRECTION_REASONS,
  ARCHITECTURE_LAYER_ORDER_REASONS,
  ARCHITECTURE_MAP_DEPENDENCY_REASONS,
  ARCHITECTURE_MAP_SIZE_REASONS,
  ARCHITECTURE_MAP_UNAVAILABLE_REASONS,
  ARCHITECTURE_NAMESPACE_TYPES,
  ARCHITECTURE_PR_LAYER_REASONS,
  ARCHITECTURE_PR_REASONS,
  ARCHITECTURE_TEST_REASONS,
  ARCHITECTURE_VIOLATION_REASONS,
  OPERATOR_ARCHITECTURE_MAP_SCHEMA,
  archctxRefusal,
  flowSelectorKey,
  flowSteps,
  type ArchitectureChangesLayerV1,
  type ArchitectureDecisionsLayerV1,
  type ArchitectureFlowEvidenceV1,
  type ArchitectureFlowSelectorV1,
  type ArchitectureImpactV1,
  type ArchitectureLayerOrderV1,
  type ArchitectureMapDependenciesV1,
  type ArchitectureMapDependencyReason,
  type ArchitectureMapFlowStepV1,
  type ArchitectureMapFlowV1,
  type ArchitectureMapImportV1,
  type ArchitectureMapNodeV1,
  type ArchitectureMapRelationV1,
  type ArchitectureMapSizeReason,
  type ArchitectureMapSizesV1,
  type ArchitectureMapUnavailableReason,
  type ArchitectureMapUnavailableV1,
  type ArchitectureMapV1,
  type ArchitectureModelChangeV1,
  type ArchitecturePullRequestImpactV1,
  type ArchitecturePullRequestsLayerV1,
  type ArchitectureTestCoverageV1,
  type ArchitectureTestsLayerV1,
  type ArchitectureViolationsLayerV1,
  type Gap,
} from './architecture-map-model';

export {
  ARCHITECTURE_CHANGE_REASONS,
  ARCHITECTURE_DEBT_KINDS,
  ARCHITECTURE_LAYER_DIRECTION_REASONS,
  ARCHITECTURE_LAYER_ORDER_REASONS,
  ARCHITECTURE_MAP_DEPENDENCY_REASONS,
  ARCHITECTURE_MAP_SIZE_REASONS,
  ARCHITECTURE_MAP_UNAVAILABLE_REASONS,
  ARCHITECTURE_MAP_WORKER_REASONS,
  ARCHITECTURE_NAMESPACE_TYPES,
  ARCHITECTURE_PR_LAYER_REASONS,
  ARCHITECTURE_PR_REASONS,
  ARCHITECTURE_TEST_REASONS,
  ARCHITECTURE_VIOLATION_READS,
  ARCHITECTURE_VIOLATION_REASONS,
  OPERATOR_ARCHITECTURE_MAP_ROUTE,
  OPERATOR_ARCHITECTURE_MAP_SCHEMA,
  archctxRefusal,
  architectureImpact,
  architectureViolationCommand,
  flowSelectorKey,
  flowSteps,
} from './architecture-map-model';
export type {
  ArchctxRefusalV1,
  ArchitectureAnchorFindingV1,
  ArchitectureChangeCommitV1,
  ArchitectureChangeReason,
  ArchitectureChangesLayerV1,
  ArchitectureDebtItemV1,
  ArchitectureDebtKind,
  ArchitectureDecisionV1,
  ArchitectureDecisionsLayerV1,
  ArchitectureFlowEvidenceV1,
  ArchitectureFlowProofV1,
  ArchitectureFlowProofsV1,
  ArchitectureFlowSelectorV1,
  ArchitectureFlowStepV1,
  ArchitectureImpactPathV1,
  ArchitectureImpactTruncationV1,
  ArchitectureImpactV1,
  ArchitectureLayerDirectionReason,
  ArchitectureLayerOrderReason,
  ArchitectureLayerOrderV1,
  ArchitectureLayerViolationV1,
  ArchitectureMapDependenciesV1,
  ArchitectureMapDependencyReason,
  ArchitectureMapFlowOutcomeV1,
  ArchitectureMapFlowStepV1,
  ArchitectureMapFlowV1,
  ArchitectureMapImportV1,
  ArchitectureMapLayersV1,
  ArchitectureMapNodeV1,
  ArchitectureMapRefusalV1,
  ArchitectureMapRelationV1,
  ArchitectureMapSizeReason,
  ArchitectureMapSizeV1,
  ArchitectureMapSizesV1,
  ArchitectureMapUnavailableReason,
  ArchitectureMapUnavailableV1,
  ArchitectureMapV1,
  ArchitectureMapWorkerReason,
  ArchitectureModelChangeV1,
  ArchitectureNamespaceType,
  ArchitecturePullRequestImpactV1,
  ArchitecturePullRequestReason,
  ArchitecturePullRequestsLayerV1,
  ArchitecturePullRequestsReason,
  ArchitectureTestCoverageV1,
  ArchitectureTestReason,
  ArchitectureTestsLayerV1,
  ArchitectureViolationReason,
  ArchitectureViolationsLayerV1,
} from './architecture-map-model';

type Check = (value: unknown) => boolean;
const text: Check = value => typeof value === 'string';
const nonEmpty: Check = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const count: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive: Check = value => count(value) && (value as number) > 0;
const match = (pattern: RegExp): Check => value => text(value) && pattern.test(value as string);
const one = (...values: unknown[]): Check => value => values.includes(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const object = (fields: Record<string, Check>): Check => value => {
  if (!isRecord(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(fields).length
    && Object.entries(fields).every(([key, check]) => Object.hasOwn(record, key) && check(record[key]));
};

/** The model's own id and layer grammar (archcontext.node/v2). */
const ENTITY_ID = /^([a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)*::)?[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/u;
const LAYER = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
const KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const id = match(ENTITY_ID);
// Model prose is free text; an absolute path in it never leaves the host.
const prose = (check: Check): Check => value => check(value) && isPublicDevActivityText(value as string);
const singleLine = prose(match(/^[^\r\n]{1,4096}$/u));
const node = object({
  id, kind: match(KIND), name: prose(nonEmpty), status: match(KIND), layer: nullable(match(LAYER)), parent: nullable(id), summary: prose(text),
  domain: nullable(match(LAYER)),
  namespace: nullable(object({ type: one(...ARCHITECTURE_NAMESPACE_TYPES) })),
  mount: nullable(object({ source: nullable(prose(nonEmpty)), target: nullable(prose(nonEmpty)), mode: one('ro', 'rw'), order: count })),
});
const relation = object({ id, kind: match(KIND), source: id, target: id, intent: prose(text), protocol: nullable(singleLine) });
const size = object({ id, files: positive, lines: count });
const imports = object({ source: id, target: id, imports: positive });
const reason = (values: readonly string[]): Check => object({ state: one('unavailable'), reason: one(...values) });
const section = (fields: Record<string, Check>, reasons: readonly string[]): Check => value => object({ state: one('ok'), ...fields })(value) || reason(reasons)(value);
const refusal: Check = value => object({ state: one('unavailable'), reason: one('archctx_error'), code: match(ARCHCTX_CODE), reason_code: nullable(match(ARCHCTX_TOKEN)) })(value);
const commit = match(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
/** A short branch name as `git symbolic-ref --short` prints it: git's ref-name rules, at most 255 characters. */
const HEAD_REF = /^(?![/.-])(?!.*\.\.)(?!.*@\{)(?!.*\/[/.])(?!.*[/.]$)(?!.*\.lock(?:\/|$))[^\x00-\x20\x7f~^:?*[\\]{1,255}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const instant = match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u);
const ids = list(id);
const layerNames: Check = value => list(match(LAYER))(value) && (value as unknown[]).length > 0;
/** A repository-relative path: no root, drive or `..` segment, and nothing the private-path guard masks. */
const repoPath: Check = value => text(value) && isPublicRepoPath(value as string);
const either = (...checks: Check[]): Check => value => checks.some(check => check(value));
// archctx reason codes are opaque kebab-case tokens; the map checks their shape, not a copy of archctx's list.
const tokens = list(match(ARCHCTX_TOKEN));
/** The flow schema's step and outcome id grammar. */
const localId = match(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/u);
const flag = one(true, false);
const impactFields = (path: Check) => ({
  paths: list(object({ path, added: nullable(count), deleted: nullable(count), owners: ids, reason_codes: tokens })),
  unowned_paths: list(path),
  nodes: list(object({ id, files: positive })),
  dependents: list(object({ id, touched: id, relations: ids })),
  dependency_coverage: one('complete', 'partial'),
  flow_steps: object({
    status: one('known', 'unknown'), reason_codes: tokens,
    items: nullable(list(object({ flow: id, step: localId, outcome: nullable(localId), reason_codes: tokens }))),
  }),
  truncated: object({ paths: flag, nodes: flag, relations: flag, flow_steps: flag, dependents: flag, model: flag }),
});
const modelChange = object({
  kind: one('nodes', 'relations', 'flows'), id, change: one('added', 'removed', 'changed'), fields: list(match(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)),
});
/** `path` checks every changed path; the decoder uses `repoPath`, and a projection uses `text` to tell a path-guard refusal from a broken answer. */
const changeCommit = object({ sha: commit, subject: prose(match(/^[^\r\n]{0,4096}$/u)), nodes: ids });
const changesWith = (path: Check): Check => either(section({ since: instant, base: commit, commits: list(changeCommit), model: list(modelChange), ...impactFields(path) }, ARCHITECTURE_CHANGE_REASONS), refusal);
const pullRequestImpactWith = (path: Check): Check => either(section(impactFields(path), ARCHITECTURE_PR_REASONS), refusal);
const changes = changesWith(repoPath);
const pullRequestImpact = pullRequestImpactWith(repoPath);
const selectorFields = { entrypoint: localId, source_symbol: singleLine, sink: localId };
const flowStep = object({ id: localId, from: localId, to: localId, label: prose(nonEmpty), evidence: object(selectorFields) });
const flow = either(
  object({
    id, capability: id, name: prose(nonEmpty), applicability: one('required'),
    participants: list(object({ id: localId, node: id })), steps: list(flowStep),
    outcomes: list(object({ id: localId, kind: one('success', 'error'), label: prose(nonEmpty), steps: list(flowStep), terminal: object({ participant: localId, label: prose(nonEmpty) }) })),
  }),
  object({ id, capability: id, name: prose(nonEmpty), applicability: one('not-applicable'), rationale: prose(nonEmpty) }),
);
const flowEvidence = object({ ...selectorFields, node: id, source_path: nullable(repoPath), sink_path: nullable(repoPath), sink_symbol: singleLine });
const anchorFindings: Check = value => list(object({
  kind: match(ARCHCTX_TOKEN), origin: one('document', 'node-summary', 'node-responsibility'), path: nullable(repoPath), line: nullable(positive), citation: prose(nonEmpty),
}))(value) && (value as unknown[]).length > 0;
const violations = object({
  debt: section({ items: list(object({ kind: one(...ARCHITECTURE_DEBT_KINDS), nodes: ids, paths: list(repoPath) })) }, ARCHITECTURE_VIOLATION_REASONS),
  flows: either(section({
    selectors: count, proven: count, unproven: count, used_unproven: count, unprovable: list(object({ id, diagnostics: count })),
    evidence: list(object({ ...selectorFields, status: match(ARCHCTX_TOKEN), call_sites: list(object({ path: repoPath, line: nullable(positive) })) })),
  }, ARCHITECTURE_VIOLATION_REASONS), refusal),
  anchors: section({ citations: count, nodes: list(object({ id, findings: anchorFindings })) }, ARCHITECTURE_VIOLATION_REASONS),
  dependencies: section({ edges: list(imports) }, ARCHITECTURE_VIOLATION_REASONS),
  layer_direction: either(section({
    imports: count, edges: list(object({ source: id, target: id, source_layer: match(LAYER), target_layer: match(LAYER), imports: positive })),
  }, ARCHITECTURE_LAYER_DIRECTION_REASONS), refusal),
});
const decisions = object({
  state: one('ok'),
  items: list(object({
    id: singleLine, title: singleLine, status: nullable(singleLine), decided_at: nullable(singleLine),
    applies_to: ids, supersedes: list(singleLine), path: repoPath,
  })),
});
const tests = section({
  run: object({ id: positive, head_sha: commit, created_at: instant }),
  results: one('ok', 'junit_missing', 'junit_invalid'),
  capabilities: list(object({ id, files: positive, passed: count, failed: count, skipped: count, no_result: count })),
}, ARCHITECTURE_TEST_REASONS);
const pullUrl = match(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/u);
const pullRequests = section({
  observed_at: instant,
  pull_requests: list(object({ number: positive, title: prose(nonEmpty), url: pullUrl, head_sha: nullable(commit), impact: pullRequestImpact })),
}, ARCHITECTURE_PR_LAYER_REASONS);
const map = object({
  schema_version: one(OPERATOR_ARCHITECTURE_MAP_SCHEMA),
  repository_id: match(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  commit,
  head_ref: nullable(match(HEAD_REF)),
  archctx_version: match(SEMVER),
  collected_at: instant,
  nodes: list(node),
  relations: list(relation),
  flows: list(flow),
  flow_evidence: list(flowEvidence),
  sizes: section({ nodes: list(size) }, ARCHITECTURE_MAP_SIZE_REASONS),
  dependencies: section({ edges: list(imports) }, ARCHITECTURE_MAP_DEPENDENCY_REASONS),
  layer_order: section({ layers: layerNames }, ARCHITECTURE_LAYER_ORDER_REASONS),
  layers: object({ changes, violations, pull_requests: pullRequests, tests, decisions }),
});

function unique(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/** Every node layer is in the order. */
function layered(nodes: readonly ArchitectureMapNodeV1[], order: readonly string[]): boolean {
  const declared = new Set(order);
  return nodes.every(entry => entry.layer === null || declared.has(entry.layer));
}

/** The parent chain ends at a top-level node; a cycle, a self parent included, never does. */
function reachesRoot(id: string, nodes: ReadonlyMap<string, ArchitectureMapNodeV1>): boolean {
  const seen = new Set<string>();
  for (let cursor: string | null = id; cursor !== null; cursor = nodes.get(cursor)?.parent ?? null) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
  }
  return true;
}

interface MapIndex {
  readonly nodes: ReadonlySet<string>;
  readonly relations: ReadonlySet<string>;
  readonly flows: ReadonlySet<string>;
  /** Each step of each required flow, by `stepKey`. */
  readonly steps: ReadonlySet<string>;
}

const stepKey = (flowId: string, outcome: string | null, step: string): string => `${flowId}\0${outcome ?? ''}\0${step}`;

function mapIndex(nodes: readonly ArchitectureMapNodeV1[], relations: readonly ArchitectureMapRelationV1[], flows: readonly ArchitectureMapFlowV1[]): MapIndex {
  return {
    nodes: new Set(nodes.map(entry => entry.id)),
    relations: new Set(relations.map(entry => entry.id)),
    flows: new Set(flows.map(entry => entry.id)),
    steps: new Set(flows.flatMap(entry => flowSteps(entry).map(({ outcome, step }) => stepKey(entry.id, outcome, step.id)))),
  };
}

/**
 * Each required flow has at least one participant and one main step, as the archctx flow schema requires, and names nodes of the map; its steps and its outcome
 * terminals name its own participants. Ids are unique where archctx keys by
 * them. Each declared selector and each proof names a selector that a step
 * names, once. Each proof also names declared evidence.
 */
function flowsValid(map: ArchitectureMapV1, nodes: ReadonlyMap<string, ArchitectureMapNodeV1>): boolean {
  const selectors = new Set(map.flows.flatMap(entry => flowSteps(entry).map(({ step }) => flowSelectorKey(step.evidence))));
  const declared = new Set(map.flow_evidence.map(flowSelectorKey));
  const named = (entries: readonly ArchitectureFlowSelectorV1[]) => unique(entries.map(flowSelectorKey)) && entries.every(entry => selectors.has(flowSelectorKey(entry)));
  const { flows: proofs } = map.layers.violations;
  return unique(map.flows.map(entry => entry.id)) && map.flows.every(entry => {
    if (nodes.get(entry.capability)?.kind !== 'capability') return false;
    if (entry.applicability !== 'required') return true;
    const participants = new Set(entry.participants.map(participant => participant.id));
    const stepsValid = (steps: readonly ArchitectureMapFlowStepV1[]) => unique(steps.map(step => step.id)) && steps.every(step => participants.has(step.from) && participants.has(step.to));
    return entry.participants.length > 0 && entry.steps.length > 0 && participants.size === entry.participants.length && entry.participants.every(participant => nodes.has(participant.node))
      && stepsValid(entry.steps) && unique(entry.outcomes.map(outcome => outcome.id))
      && entry.outcomes.every(outcome => stepsValid(outcome.steps) && participants.has(outcome.terminal.participant));
  }) && named(map.flow_evidence) && map.flow_evidence.every(entry => nodes.has(entry.node))
    && (proofs.state !== 'ok' || (named(proofs.evidence) && proofs.evidence.every(entry => declared.has(flowSelectorKey(entry)))));
}

/**
 * archctx's own consistency, and every id it names is a node or relation of the
 * map. `owner` also admits a node that today's changes removed: a deleted path
 * keeps its base owner.
 */
function impactValid(impact: ArchitectureImpactV1, index: MapIndex, owner: (id: string) => boolean): boolean {
  const unowned = impact.paths.filter(entry => entry.owners.length === 0).map(entry => entry.path);
  const { flow_steps: steps } = impact;
  return unique(impact.paths.map(entry => entry.path)) && impact.paths.every(entry => unique(entry.owners) && entry.owners.every(owner))
    && unowned.length === impact.unowned_paths.length && unowned.every((path, position) => path === impact.unowned_paths[position])
    && unique(impact.nodes.map(entry => entry.id)) && impact.nodes.every(entry => owner(entry.id))
    && impact.dependents.every(entry => index.nodes.has(entry.id) && owner(entry.touched) && entry.relations.length > 0 && entry.relations.every(relation => index.relations.has(relation)))
    && (steps.status === 'known' ? steps.reason_codes.length === 0 && steps.items !== null : steps.reason_codes.length > 0)
    && (steps.items ?? []).every(item => index.steps.has(stepKey(item.flow, item.outcome, item.step)));
}

/** Today's changes: an added or changed node, relation or flow is in the map, a removed one is not. Each commit names its owners as `paths` does. */
function changesValid(value: unknown, index: MapIndex, path: Check = repoPath): boolean {
  if (!(path === repoPath ? changes : changesWith(path))(value)) return false;
  const layer = value as ArchitectureChangesLayerV1;
  if (layer.state !== 'ok') return true;
  const removed = new Set(layer.model.filter(entry => entry.kind === 'nodes' && entry.change === 'removed').map(entry => entry.id));
  const present = (kind: ArchitectureModelChangeV1['kind'], has: ReadonlySet<string>) => layer.model.filter(entry => entry.kind === kind).every(entry => (entry.change === 'removed') !== has.has(entry.id));
  const owner = (nodeId: string) => index.nodes.has(nodeId) || removed.has(nodeId);
  return unique(layer.model.map(entry => `${entry.kind}\0${entry.id}`)) && present('nodes', index.nodes) && present('relations', index.relations) && present('flows', index.flows)
    && unique(layer.commits.map(entry => entry.sha)) && layer.commits.every(entry => unique(entry.nodes) && entry.nodes.every(owner))
    && impactValid(layer, index, owner);
}

/** One PR's impact names only nodes of the map commit's model. */
function pullRequestImpactValid(value: unknown, index: MapIndex, path: Check = repoPath): boolean {
  if (!(path === repoPath ? pullRequestImpact : pullRequestImpactWith(path))(value)) return false;
  const impact = value as ArchitecturePullRequestImpactV1['impact'];
  return impact.state !== 'ok' || impactValid(impact, index, nodeId => index.nodes.has(nodeId));
}

/**
 * A layer-direction answer needs the map's layer order. Each pair is one node pair
 * of this map, each layer is that node's model layer, and the target's layer is
 * above the source's.
 */
function layerDirectionValid(map: ArchitectureMapV1, nodes: ReadonlyMap<string, ArchitectureMapNodeV1>): boolean {
  const direction = map.layers.violations.layer_direction;
  if (direction.state !== 'ok') return true;
  if (map.layer_order.state !== 'ok') return false;
  const rank = new Map(map.layer_order.layers.map((layer, index) => [layer, index]));
  return unique(direction.edges.map(entry => `${entry.source}\0${entry.target}`)) && direction.edges.every(entry =>
    nodes.get(entry.source)?.layer === entry.source_layer && nodes.get(entry.target)?.layer === entry.target_layer
    && (rank.get(entry.target_layer) ?? Infinity) < (rank.get(entry.source_layer) ?? -Infinity));
}

/** Shape, identity and referential integrity. Every reference names a node of this map, except a removed model entity. */
export function decodeArchitectureMap(value: unknown): ArchitectureMapV1 {
  if (!map(value)) throw new Error('architecture_map_invalid');
  const result = value as ArchitectureMapV1;
  const nodes = new Map(result.nodes.map(entry => [entry.id, entry]));
  const relations = new Set(result.relations.map(entry => entry.id));
  const index = mapIndex(result.nodes, result.relations, result.flows);
  const capability = (nodeId: string) => nodes.get(nodeId)?.kind === 'capability';
  // Each list names each node once, and only nodes of this map.
  const known = (entries: readonly string[], exists: (entry: string) => boolean = entry => nodes.has(entry)) => unique(entries) && entries.every(exists);
  const importEdges = (edges: readonly ArchitectureMapImportV1[]) => unique(edges.map(entry => `${entry.source}\0${entry.target}`))
    && edges.every(entry => entry.source !== entry.target && capability(entry.source) && capability(entry.target));
  const { violations, pull_requests: pulls, tests, decisions: decided } = result.layers;
  if (nodes.size !== result.nodes.length || relations.size !== result.relations.length
    || result.nodes.some(entry => (entry.domain !== null) !== (entry.kind === 'capability') || (entry.namespace !== null) !== (entry.kind === 'namespace')
      || (entry.mount !== null) !== (entry.kind === 'mount'))
    || result.nodes.some(entry => entry.parent !== null && !nodes.has(entry.parent)) || result.nodes.some(entry => !reachesRoot(entry.id, nodes))
    || result.relations.some(entry => !nodes.has(entry.source) || !nodes.has(entry.target))
    || (result.layer_order.state === 'ok' && (!unique(result.layer_order.layers) || !layered(result.nodes, result.layer_order.layers)))
    || (result.sizes.state === 'ok' && !known(result.sizes.nodes.map(entry => entry.id)))
    || (result.dependencies.state === 'ok' && !importEdges(result.dependencies.edges))
    || !changesValid(result.layers.changes, index)
    || (violations.debt.state === 'ok' && violations.debt.items.some(item => !known(item.nodes) || !unique(item.paths)))
    || (violations.flows.state === 'ok' && !known(violations.flows.unprovable.map(entry => entry.id), capability))
    || (violations.anchors.state === 'ok' && !known(violations.anchors.nodes.map(entry => entry.id)))
    || (violations.dependencies.state === 'ok' && !importEdges(violations.dependencies.edges))
    || !layerDirectionValid(result, nodes)
    || !flowsValid(result, nodes)
    || (pulls.state === 'ok' && (!unique(pulls.pull_requests.map(entry => String(entry.number))) || pulls.pull_requests.some(entry => !pullRequestImpactValid(entry.impact, index)
      || (entry.impact.state === 'ok' ? entry.head_sha === null : (entry.head_sha === null) !== (entry.impact.reason === 'head_missing')))))
    || (tests.state === 'ok' && (!known(tests.capabilities.map(entry => entry.id), capability)
      || tests.capabilities.some(entry => entry.files !== entry.passed + entry.failed + entry.skipped + entry.no_result)))
    || !unique(decided.items.map(entry => entry.id)) || decided.items.some(entry => !known(entry.applies_to))) {
    throw new Error('architecture_map_invalid');
  }
  return result;
}

export type ArchitectureMapSizeInput =
  | {
    readonly state: 'ok';
    /** Lines of each tracked text file of the commit. */
    readonly lines: ReadonlyMap<string, number>;
    /** The deepest owning node of each path from `archctx resolve`; null when unowned or contested. */
    readonly owners: ReadonlyMap<string, string | null>;
  }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapSizeReason };

export type ArchitectureMapDependencyInput =
  | { readonly state: 'ok'; readonly matrix: readonly { readonly from: string; readonly to: string; readonly imports: number }[] }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapDependencyReason };

/** One open PR as the Dev Activity cache holds it; the title is masked like model prose. */
export interface ArchitecturePullRequestSourceV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly head_sha: string | null;
  readonly changed_files: PullRequestFiles;
}

/** The open PRs of one repository from the Dev Activity cache; the collector hands it to the map child. */
export type ArchitecturePullRequestsSource =
  | { readonly state: 'ok'; readonly observed_at: string; readonly pull_requests: readonly ArchitecturePullRequestSourceV1[] }
  | Gap<'dev_activity_pending' | 'dev_activity_unavailable'>;

const pullRequestsSource = section({
  observed_at: instant,
  pull_requests: list(object({
    number: positive, title: prose(nonEmpty), url: pullUrl, head_sha: nullable(commit),
    changed_files: section({ paths: list(repoPath) }, PULL_REQUEST_FILES_REASONS),
  })),
}, ['dev_activity_pending', 'dev_activity_unavailable']);

/** The map child reads the source from a file the collector wrote; the same shape check applies. */
export function decodeArchitecturePullRequestsSource(value: unknown): ArchitecturePullRequestsSource {
  if (!pullRequestsSource(value)) throw new Error('architecture_pull_requests_invalid');
  return value as ArchitecturePullRequestsSource;
}

/** The unavailable state that a map route refusal names; null when the body is not such a refusal. */
export function decodeArchitectureMapRefusal(body: unknown): ArchitectureMapUnavailableV1 | null {
  const record = (value: unknown) => isRecord(value) ? value : null;
  const code = record(record(body)?.error)?.code;
  if (code === 'archctx_error') {
    const archctx = record(record(body)?.archctx);
    return archctx === null ? null : archctxRefusal(archctx.code, archctx.reason_code);
  }
  return (ARCHITECTURE_MAP_UNAVAILABLE_REASONS as readonly unknown[]).includes(code) ? { state: 'unavailable', reason: code as ArchitectureMapUnavailableReason } : null;
}

export interface ArchitectureMapLayersInput {
  readonly changes: ArchitectureChangesLayerV1;
  readonly pull_requests: ArchitecturePullRequestsLayerV1;
  readonly violations: ArchitectureViolationsLayerV1;
  readonly tests: ArchitectureTestsLayerV1;
  readonly decisions: ArchitectureDecisionsLayerV1;
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const byId = <T extends { readonly id: string }>(entries: readonly T[]): T[] => [...entries].sort((a, b) => compare(a.id, b.id));
const byEdge = <T extends { readonly source: string; readonly target: string }>(entries: readonly T[]): T[] =>
  [...entries].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target));
const bySelector = <T extends ArchitectureFlowSelectorV1>(entries: readonly T[]): T[] => [...entries].sort((a, b) => compare(flowSelectorKey(a), flowSelectorKey(b)));

/**
 * Adds each owned path's counts to its owner and every ancestor on the model's
 * `parent` chain, so a capability shows the counts of its components. An owner
 * the model does not name returns null: the model and the ownership answer then
 * come from different model revisions.
 */
function rollUp<Counts extends Record<string, number>>(
  parents: ReadonlyMap<string, string | null>,
  entries: Iterable<readonly [string | null, Counts]>,
): Map<string, Counts> | null {
  const totals = new Map<string, Counts>();
  for (const [owner, counts] of entries) {
    if (owner === null) continue;
    if (!parents.has(owner)) return null;
    // The decoder refuses parent cycles later; this walk must still end on one.
    const seen = new Set<string>();
    for (let cursor: string | null = owner; cursor !== null && !seen.has(cursor); cursor = parents.get(cursor) ?? null) {
      seen.add(cursor);
      const total = totals.get(cursor);
      totals.set(cursor, Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, (total?.[key] ?? 0) + value])) as Counts);
    }
  }
  return totals;
}

const ARCHCTX_FAILED = { state: 'unavailable', reason: 'archctx_failed' } as const;
const PATH_NOT_PUBLIC = { state: 'unavailable', reason: 'path_not_public' } as const;

/**
 * The reason an impact answer cannot be shown: valid except for a path that the
 * public-path guard refuses is `path_not_public`; any other break is `archctx_failed`.
 */
function impactGap(valid: (path: Check) => boolean): typeof ARCHCTX_FAILED | typeof PATH_NOT_PUBLIC {
  return valid(text) ? PATH_NOT_PUBLIC : ARCHCTX_FAILED;
}

/** Each open PR keeps its impact only when it names nodes of the map; any other impact drops that PR to `archctx_failed`, or to `path_not_public` when only a path is refused. */
function projectPullRequests(layer: ArchitecturePullRequestsLayerV1, index: MapIndex): ArchitecturePullRequestsLayerV1 {
  if (layer.state === 'unavailable') return layer;
  return {
    ...layer,
    pull_requests: layer.pull_requests.map(pr => (pullRequestImpactValid(pr.impact, index) ? pr : { ...pr, impact: impactGap(path => pullRequestImpactValid(pr.impact, index, path)) })),
  };
}

/** The tests collector's cache for one repository, as `tests-collector.ts` holds it. */
export type ArchitectureTestsSource =
  | { readonly state: 'ready'; readonly snapshot: TestsSnapshotV1 }
  | { readonly state: 'unavailable'; readonly reason: TestsUnavailableReason };

/**
 * Test files per capability from the daily run's projection, by result. A file
 * counts once for each capability it reaches, by import or by the capability's
 * declared verification. Without a JUnit report every file is `no_result`.
 */
export function projectTestCoverage(nodes: readonly ArchitectureMapNodeV1[], source: ArchitectureTestsSource): ArchitectureTestsLayerV1 {
  if (source.state === 'unavailable') return source;
  const { run, projection, results } = source.snapshot;
  if (projection.state === 'unavailable') return projection;
  const capabilities = new Set(nodes.filter(node => node.kind === 'capability').map(node => node.id));
  if (projection.files.some(file => file.capabilities.some(link => !capabilities.has(link.id)))) return { state: 'unavailable', reason: 'tests_model_mismatch' };
  const outcome = new Map(results.state === 'ok' ? results.files.map(file => [file.file,
    file.cases.some(entry => entry.result === 'failed') ? 'failed' as const
      : file.cases.some(entry => entry.result === 'passed') ? 'passed' as const
        : file.cases.length > 0 ? 'skipped' as const : 'no_result' as const]) : []);
  const totals = new Map<string, ArchitectureTestCoverageV1>();
  for (const file of projection.files) {
    const result = outcome.get(file.file) ?? 'no_result';
    for (const link of file.capabilities) {
      const total = totals.get(link.id) ?? { id: link.id, files: 0, passed: 0, failed: 0, skipped: 0, no_result: 0 };
      totals.set(link.id, { ...total, files: total.files + 1, [result]: total[result] + 1 });
    }
  }
  return {
    state: 'ok',
    run: { id: run.id, head_sha: run.head_sha, created_at: run.created_at },
    results: results.state === 'ok' ? 'ok' : results.reason,
    capabilities: byId([...totals.values()]),
  };
}

/** The map with the tests layer read from the tests collector's cache. */
export function withTestCoverage(map: ArchitectureMapV1, source: ArchitectureTestsSource): ArchitectureMapV1 {
  return decodeArchitectureMap({ ...map, layers: { ...map.layers, tests: projectTestCoverage(map.nodes, source) } });
}

/**
 * Builds the map. Line counts sum along the `parent` chain; an owner of a line
 * count that the model does not name fails the projection. An impact answer
 * that names a node or relation the model does not have drops today's changes,
 * or that PR's impact, to `archctx_failed`; one whose only fault is a path that
 * the public-path guard refuses drops to `path_not_public`.
 */
export function projectArchitectureMap(input: {
  readonly repository_id: string;
  readonly commit: string;
  readonly head_ref: string | null;
  readonly archctx_version: string;
  readonly collected_at: string;
  readonly nodes: readonly ArchitectureMapNodeV1[];
  readonly relations: readonly ArchitectureMapRelationV1[];
  readonly flows: readonly ArchitectureMapFlowV1[];
  readonly flow_evidence: readonly ArchitectureFlowEvidenceV1[];
  readonly sizes: ArchitectureMapSizeInput;
  readonly dependencies: ArchitectureMapDependencyInput;
  readonly layer_order: ArchitectureLayerOrderV1;
  readonly layers: ArchitectureMapLayersInput;
}): ArchitectureMapV1 {
  const parents = new Map(input.nodes.map(entry => [entry.id, entry.parent]));
  const index = mapIndex(input.nodes, input.relations, input.flows);
  let sizes: ArchitectureMapSizesV1 = input.sizes.state === 'ok' ? { state: 'ok', nodes: [] } : input.sizes;
  if (input.sizes.state === 'ok') {
    const { owners } = input.sizes;
    const totals = rollUp(parents, [...input.sizes.lines].map(([path, lines]) => [owners.get(path) ?? null, { files: 1, lines }] as const));
    if (totals === null) throw new Error('architecture_map_invalid');
    sizes = { state: 'ok', nodes: byId([...totals].map(([id, total]) => ({ id, ...total }))) };
  }
  const dependencies: ArchitectureMapDependenciesV1 = input.dependencies.state === 'ok'
    ? {
      state: 'ok',
      edges: byEdge(input.dependencies.matrix.filter(entry => entry.from !== entry.to && entry.imports > 0)
        .map(entry => ({ source: entry.from, target: entry.to, imports: entry.imports }))),
    }
    : input.dependencies;
  const { violations, decisions } = input.layers;
  return decodeArchitectureMap({
    schema_version: OPERATOR_ARCHITECTURE_MAP_SCHEMA,
    repository_id: input.repository_id,
    commit: input.commit,
    head_ref: input.head_ref,
    archctx_version: input.archctx_version,
    collected_at: input.collected_at,
    nodes: byId(input.nodes),
    relations: byId(input.relations),
    flows: byId(input.flows),
    flow_evidence: bySelector(input.flow_evidence),
    sizes,
    dependencies,
    layer_order: input.layer_order,
    layers: {
      changes: changesValid(input.layers.changes, index) ? input.layers.changes : impactGap(path => changesValid(input.layers.changes, index, path)),
      violations: {
        debt: violations.debt,
        flows: violations.flows.state === 'ok'
          ? { ...violations.flows, unprovable: byId(violations.flows.unprovable), evidence: bySelector(violations.flows.evidence) } : violations.flows,
        anchors: violations.anchors.state === 'ok' ? { ...violations.anchors, nodes: byId(violations.anchors.nodes) } : violations.anchors,
        dependencies: violations.dependencies.state === 'ok' ? { state: 'ok', edges: byEdge(violations.dependencies.edges) } : violations.dependencies,
        layer_direction: violations.layer_direction.state === 'ok' ? { ...violations.layer_direction, edges: byEdge(violations.layer_direction.edges) } : violations.layer_direction,
      },
      pull_requests: projectPullRequests(input.layers.pull_requests, index),
      tests: input.layers.tests,
      decisions: { state: 'ok', items: byId(decisions.items) },
    },
  });
}

