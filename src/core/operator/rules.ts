// Public, browser-safe contract for the cache-only rules route. The status
// document is the CLI's RuleStatusV1; validation never changes its contents.
import type { RuleStatusV1 } from '../ci/rule-candidates';
import { ROUTING_CLASSES, SEAT_IDS, SEAT_RUNTIMES, type RoutingClass, type SeatId, type SeatRuntime } from '../board/seats-settings';
import { decodeReaders } from '../evidence/decode-readers';
import { isPublicDevActivityText } from '../public-projections/public-text';

export const OPERATOR_RULES_KIND = 'operator_rules' as const;
export const RULES_UNAVAILABLE_REASONS = [
  'rules_pending', 'registry_unavailable', 'repository_not_found', 'rules_command_failed', 'rules_invalid',
] as const;
export type RulesUnavailableReason = typeof RULES_UNAVAILABLE_REASONS[number];

/** The prefilled `rh rules promote --print-prompt` text of one open action for one routing class. */
export interface RulesPromptV1 {
  readonly candidate_id: string;
  readonly route: RoutingClass;
  readonly prompt: string;
}

/** The seat `selectSeatRoute` gives a routing class now; all null when no seat may take it. */
export interface RulesRouteV1 {
  readonly class: RoutingClass;
  readonly seat: SeatId | null;
  readonly runtime: SeatRuntime | null;
  readonly model: string | null;
}

export interface RulesSnapshotV1 {
  readonly protocol: 1;
  readonly kind: typeof OPERATOR_RULES_KIND;
  readonly repository_id: string;
  readonly collected_at: string;
  readonly status: RuleStatusV1;
  /** Empty on a dirty or invalid ledger, where the CLI refuses to render a prompt. */
  readonly prompts: readonly RulesPromptV1[];
  /** One row per routing class in `ROUTING_CLASSES` order; null when the seats config or quota could not be read. */
  readonly routes: readonly RulesRouteV1[] | null;
  readonly herdr: 'ready' | 'unavailable';
}

/** The write body bound is 64 KiB; a prompt must fit with its JSON escapes. */
export const RULES_PROMPT_MAX_LENGTH = 48 * 1024;

/** Text within the bound with no lone surrogate; newline and tab are the only control characters. */
export function isRulesPromptText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= RULES_PROMPT_MAX_LENGTH
    && !/[\x00-\x08\x0b-\x1f\x7f\uD800-\uDFFF]/u.test(value);
}

const PROGRESS = ['waiting_orchestration', 'in_progress', 'ready_for_go', 'merged', 'closed_unfinished', 'pr_rejected', 'failed', 'unknown'] as const;
const TASK_KEYS = ['issue', 'url', 'route', 'progress', 'seat', 'pull_request'];
const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*$/u;

/** Closed shapes at every level; no raw terminal output or private path can leave the cache. */
export function decodeRulesSnapshot(value: unknown): RulesSnapshotV1 {
  const fail = (what: string): never => { throw new Error(`rules snapshot invalid: ${what}`); };
  const { obj, array, bool, count, match, oneOf } = decodeReaders(fail);
  const publicText = (v: unknown, what: string, empty = false): string => {
    if (typeof v !== 'string' || (!empty && v.length === 0)
      || /[\x00-\x1f\x7f]/u.test(v) || v === '/' || !isPublicDevActivityText(v)
      || /\\/u.test(v)) return fail(what);
    return v;
  };
  const text = (v: unknown, what: string, empty = false): string => {
    const value = publicText(v, what, empty);
    return value.length <= 500 ? value : fail(what);
  };
  const positive = (v: unknown, what: string) => count(v, what) > 0 || fail(what);
  const root = obj(value, ['protocol', 'kind', 'repository_id', 'collected_at', 'status', 'prompts', 'routes', 'herdr'], 'snapshot');
  if (root.protocol !== 1 || root.kind !== OPERATOR_RULES_KIND) fail('kind');
  match(root.repository_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'repository_id');
  match(root.collected_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u, 'collected_at');
  // `rules status --tasks` adds `orchestration` and each action's `task`.
  const tasks = typeof root.status === 'object' && root.status !== null && 'orchestration' in root.status;
  const status = obj(root.status, ['kind', 'protocol', 'repository_id', 'ledger', 'themes', ...(tasks ? ['orchestration'] : [])], 'status');
  if (status.kind !== 'repo-harness.rules.status' || status.protocol !== 1) fail('status kind');
  match(text(status.repository_id, 'status repository_id'), /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u, 'status repository_id');
  const ledger = obj(status.ledger, ['path', 'head', 'blob', 'dirty', 'valid', 'entries', 'field_errors', 'evidence_errors'], 'ledger');
  if (ledger.path !== 'tasks/lessons.md') fail('ledger path');
  for (const field of ['head', 'blob']) match(ledger[field], /^[0-9a-f]{40,64}$/u, `ledger ${field}`);
  bool(ledger.dirty, 'ledger dirty');
  bool(ledger.valid, 'ledger valid');
  if (ledger.entries !== null) count(ledger.entries, 'ledger entries');
  for (const raw of array(ledger.field_errors, 'field errors')) {
    const row = obj(raw, ['line', 'theme', 'field', 'value', 'fix'], 'field error');
    positive(row.line, 'field error line');
    for (const field of ['theme', 'field', 'value', 'fix']) text(row[field], `field error ${field}`, field === 'theme' || field === 'value');
  }
  for (const raw of array(ledger.evidence_errors, 'evidence errors')) {
    const row = obj(raw, ['theme', 'trigger'], 'evidence error');
    text(row.theme, 'evidence error theme');
    text(row.trigger, 'evidence error trigger');
  }
  const positiveOrNull = (v: unknown, what: string) => { if (v !== null) positive(v, what); };
  const task = (v: unknown) => {
    if (v === null) return;
    const row = obj(v, Object.hasOwn(v as object, 'reason') ? [...TASK_KEYS, 'reason'] : TASK_KEYS, 'task');
    positiveOrNull(row.issue, 'task issue');
    if (row.url !== null) match(row.url, ISSUE_URL, 'task url');
    if (row.route !== null) oneOf(row.route, ROUTING_CLASSES, 'task route');
    oneOf(row.progress, PROGRESS, 'task progress');
    if (row.reason !== undefined) match(row.reason, /^[a-z][a-z0-9_]{0,63}$/u, 'task reason');
    if (row.seat !== null) text(row.seat, 'task seat');
    if (row.pull_request !== null) {
      const pr = obj(row.pull_request, ['number', 'url', 'head_sha', 'base_sha'], 'task pull request');
      positive(pr.number, 'task pull request number');
      match(pr.url, ISSUE_URL, 'task pull request url');
      for (const field of ['head_sha', 'base_sha']) match(pr[field], /^[0-9a-f]{40,64}$/u, `task pull request ${field}`);
    }
  };
  if (tasks) {
    const orchestration = obj(status.orchestration, ['parent', 'plan_comment', 'coordinator_claim'], 'orchestration');
    positiveOrNull(orchestration.parent, 'orchestration parent');
    bool(orchestration.plan_comment, 'orchestration plan_comment');
    bool(orchestration.coordinator_claim, 'orchestration coordinator_claim');
  }
  const keys = new Set<string>();
  const candidates = new Set<string>();
  for (const raw of array(status.themes, 'themes')) {
    const row = obj(raw, ['key', 'theme', 'name', 'prevention_rule', 'why', 'correction_sources', 'seen', 'enforced_by', 'promoted', 'lines', 'governance', 'actions'], 'theme');
    const key = text(row.key, 'theme key');
    if (keys.has(key)) fail('duplicate theme');
    keys.add(key);
    text(row.theme, 'theme');
    // Lesson prose has no short-field limit; the same public text safety checks apply.
    for (const field of ['prevention_rule', 'why']) publicText(row[field], field, true);
    for (const source of array(row.correction_sources, 'correction_sources')) text(source, 'correction source');
    text(row.enforced_by, 'enforced_by');
    for (const field of ['name', 'promoted']) if (row[field] !== null) text(row[field], field);
    positive(row.seen, 'seen');
    for (const line of array(row.lines, 'lines')) positive(line, 'line');
    oneOf(row.governance, ['structural', 'judgment_promoted', 'judgment_unpromoted'], 'governance');
    const actions = new Set<string>();
    for (const rawAction of array(row.actions, 'actions')) {
      const action = obj(rawAction, ['kind', 'candidate_id', ...(tasks ? ['task'] : [])], 'action');
      const kind = oneOf(action.kind, ['enforce', 'promote_root'], 'action kind');
      if (actions.has(kind)) fail('duplicate action');
      actions.add(kind);
      const id = match(action.candidate_id, /^[0-9a-f]{64}$/u, 'candidate_id');
      if (candidates.has(id)) fail('duplicate candidate_id');
      candidates.add(id);
      if (tasks) task(action.task);
    }
  }
  const prompts = new Set<string>();
  for (const raw of array(root.prompts, 'prompts')) {
    const row = obj(raw, ['candidate_id', 'route', 'prompt'], 'prompt');
    const id = match(row.candidate_id, /^[0-9a-f]{64}$/u, 'prompt candidate_id');
    if (!candidates.has(id)) fail('prompt candidate');
    const route = oneOf(row.route, ROUTING_CLASSES, 'prompt route');
    if (prompts.has(`${id}:${route}`)) fail('duplicate prompt');
    prompts.add(`${id}:${route}`);
    const prompt = isRulesPromptText(row.prompt) ? row.prompt : fail('prompt text');
    for (const line of prompt.split('\n')) publicText(line, 'prompt line', true);
  }
  if (root.routes !== null) {
    const routes = array(root.routes, 'routes');
    if (routes.length !== ROUTING_CLASSES.length) fail('routes');
    routes.forEach((raw, at) => {
      const row = obj(raw, ['class', 'seat', 'runtime', 'model'], 'route');
      if (row.class !== ROUTING_CLASSES[at]) fail('route class');
      if (row.seat === null) {
        if (row.runtime !== null || row.model !== null) fail('route without seat');
        return;
      }
      oneOf(row.seat, SEAT_IDS, 'route seat');
      oneOf(row.runtime, SEAT_RUNTIMES, 'route runtime');
      if (row.model !== null) text(row.model, 'route model');
    });
  }
  oneOf(root.herdr, ['ready', 'unavailable'], 'herdr');
  return value as RulesSnapshotV1;
}
