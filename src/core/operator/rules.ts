// Public, browser-safe contract for the cache-only rules route. The status
// document is the CLI's RuleStatusV1; validation never changes its contents.
import type { RuleStatusV1 } from '../ci/rule-candidates';
import { decodeReaders } from '../evidence/decode-readers';
import { isPublicDevActivityText } from '../public-projections/public-text';

export const OPERATOR_RULES_KIND = 'operator_rules' as const;
export const RULES_UNAVAILABLE_REASONS = [
  'rules_pending', 'registry_unavailable', 'repository_not_found', 'rules_command_failed', 'rules_invalid',
] as const;
export type RulesUnavailableReason = typeof RULES_UNAVAILABLE_REASONS[number];

export interface RulesSnapshotV1 {
  readonly protocol: 1;
  readonly kind: typeof OPERATOR_RULES_KIND;
  readonly repository_id: string;
  readonly collected_at: string;
  readonly status: RuleStatusV1;
}

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
  const root = obj(value, ['protocol', 'kind', 'repository_id', 'collected_at', 'status'], 'snapshot');
  if (root.protocol !== 1 || root.kind !== OPERATOR_RULES_KIND) fail('kind');
  match(root.repository_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'repository_id');
  match(root.collected_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u, 'collected_at');
  const status = obj(root.status, ['kind', 'protocol', 'repository_id', 'ledger', 'themes'], 'status');
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
  const keys = new Set<string>();
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
      const action = obj(rawAction, ['kind', 'candidate_id'], 'action');
      const kind = oneOf(action.kind, ['enforce', 'promote_root'], 'action kind');
      if (actions.has(kind)) fail('duplicate action');
      actions.add(kind);
      match(action.candidate_id, /^[0-9a-f]{64}$/u, 'candidate_id');
    }
  }
  return value as RulesSnapshotV1;
}
