// The read model of the rules page: the ledger state, every theme of the
// lessons ledger, and the promotion actions that are open for a theme, each
// with a stable candidate id. The ledger text has one parser, the
// `maintenance-triage` helper; this module decodes that document and adds no
// second reading of the ledger.
//
// `candidate_id` is the one identity of a promotion task. #2887 finds an open
// issue by it and #2890 puts it in the URL of the candidate drawer, so it must
// not change between two runs and must not depend on the checkout path: the
// command gives a repository identity that is the same on every host (see
// `repositoryIdentity` in `src/cli/commands/rules.ts`).

import { isRecord } from '../evidence/is-record';
import { sha256Hex } from '../evidence/sha256';

export const RULES_STATUS_KIND = 'repo-harness.rules.status' as const;
export const RULES_STATUS_PROTOCOL = 1 as const;
/** The ledger path, repository-relative; the document never holds an absolute path. */
export const RULES_LEDGER_PATH = 'tasks/lessons.md' as const;
/** The first line of the candidate digest input; a change of the digest input needs a new version. */
export const CANDIDATE_ID_DOMAIN = 'repo-harness.rules.candidate.v1' as const;

/** Who keeps a theme from coming back. `judgment` is the one value with no machine check. */
export const JUDGMENT_ENFORCER = 'judgment' as const;

export type RuleActionKind = 'enforce' | 'promote_root';
export type RuleGovernance = 'structural' | 'judgment_promoted' | 'judgment_unpromoted';

/** A theme row of `maintenance-triage --json`. */
export interface TriageThemeV1 {
  readonly key: string;
  readonly theme: string;
  readonly name: string | null;
  readonly prevention_rule: string;
  readonly why: string;
  /** Every correction source across the theme's entries, unique and sorted. */
  readonly correction_sources: readonly string[];
  readonly seen: number;
  readonly enforced_by: string;
  readonly promoted: string | null;
  /** The `- Date:` line of every entry of this theme, ascending. */
  readonly lines: readonly number[];
}

export interface TriageFieldErrorV1 {
  readonly line: number;
  readonly theme: string;
  readonly field: string;
  readonly value: string;
  readonly fix: string;
}

export interface TriageEvidenceErrorV1 {
  readonly theme: string;
  readonly trigger: string;
}

/**
 * The decoded triage document. `themes` is null when the helper found a field
 * error, because no theme reduction is possible then; `judgment` is not
 * consumed here, so its rows are only checked to be objects.
 */
export interface TriageReportV1 {
  readonly judgment: readonly unknown[] | null;
  readonly themes: readonly TriageThemeV1[] | null;
  readonly field_errors: readonly TriageFieldErrorV1[];
  readonly evidence_errors: readonly TriageEvidenceErrorV1[];
}

export type RuleTaskProgress = 'waiting_orchestration' | 'in_progress' | 'ready_for_go' | 'merged'
  | 'closed_unfinished' | 'pr_rejected' | 'failed' | 'unknown';

export interface RuleTaskV1 {
  /** Null identity fields mean discovery failed, not that no task exists. */
  readonly issue: number | null;
  readonly url: string | null;
  /** The effects boundary supplies the route validated by the promotion marker parser. */
  readonly route: string | null;
  readonly progress: RuleTaskProgress;
  /** A stable code, never provider stderr or an exception message. */
  readonly reason?: string;
  readonly seat: string | null;
  readonly pull_request: {
    readonly number: number;
    readonly url: string;
    readonly head_sha: string;
    readonly base_sha: string;
  } | null;
}

export interface RuleOrchestrationV1 {
  readonly parent: number | null;
  readonly plan_comment: boolean;
  readonly coordinator_claim: boolean;
}

export interface RuleCandidateActionV1 {
  readonly kind: RuleActionKind;
  readonly candidate_id: string;
  /** Present only with --tasks. Null means the complete read found no task. */
  readonly task?: RuleTaskV1 | null;
}

export interface RuleThemeV1 extends TriageThemeV1 {
  readonly governance: RuleGovernance;
  /** Open actions, `enforce` first. A `structural` theme has none. */
  readonly actions: readonly RuleCandidateActionV1[];
}

/** What the command read from the checkout; every value comes from git, not from the ledger text. */
export interface RuleLedgerReadV1 {
  readonly head: string;
  readonly blob: string;
  readonly dirty: boolean;
}

export interface RuleStatusV1 {
  readonly kind: typeof RULES_STATUS_KIND;
  readonly protocol: typeof RULES_STATUS_PROTOCOL;
  readonly repository_id: string;
  readonly ledger: RuleLedgerReadV1 & {
    readonly path: typeof RULES_LEDGER_PATH;
    readonly valid: boolean;
    /** The number of ledger entries; null when the helper gave no theme reduction. */
    readonly entries: number | null;
    readonly field_errors: readonly TriageFieldErrorV1[];
    readonly evidence_errors: readonly TriageEvidenceErrorV1[];
  };
  readonly themes: readonly RuleThemeV1[];
  /** Present only with --tasks; governance still comes only from the ledger. */
  readonly orchestration?: RuleOrchestrationV1;
}

const TEXT_LIMIT = 500;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_LIMIT || CONTROL.test(value)) {
    throw new Error(`rules triage invalid: ${what}`);
  }
  return value;
}

/** A field error is reported on a broken entry, so its theme and value can be empty text. */
function freeText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT || CONTROL.test(value)) {
    throw new Error(`rules triage invalid: ${what}`);
  }
  return value;
}

/** The ledger parser accepts continued lesson prose with no short-field length limit. */
function lessonProse(value: unknown, what: string): string {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new Error(`rules triage invalid: ${what}`);
  return value;
}

function keys(value: unknown, expected: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`rules triage invalid: ${what}`);
  }
  return value;
}

function count(value: unknown, what: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`rules triage invalid: ${what}`);
  return value;
}

function list<T>(value: unknown, what: string, read: (item: unknown, at: number) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`rules triage invalid: ${what}`);
  return value.map(read);
}

function decodeTheme(value: unknown, at: number): TriageThemeV1 {
  const row = keys(value, ['key', 'theme', 'name', 'prevention_rule', 'why', 'correction_sources', 'seen', 'enforced_by', 'promoted', 'lines'], `themes[${at}]`);
  // The key grammar is the ledger contract that `LedgerEnforcement` checks (#2815).
  // A second grammar here would make two authorities for one value.
  return {
    key: text(row.key, `themes[${at}].key`),
    theme: text(row.theme, `themes[${at}].theme`),
    name: row.name === null ? null : text(row.name, `themes[${at}].name`),
    prevention_rule: lessonProse(row.prevention_rule, `themes[${at}].prevention_rule`),
    why: lessonProse(row.why, `themes[${at}].why`),
    correction_sources: list(row.correction_sources, `themes[${at}].correction_sources`, (source, index) => text(source, `themes[${at}].correction_sources[${index}]`)),
    seen: count(row.seen, `themes[${at}].seen`, 1),
    enforced_by: text(row.enforced_by, `themes[${at}].enforced_by`),
    promoted: row.promoted === null ? null : text(row.promoted, `themes[${at}].promoted`),
    lines: list(row.lines, `themes[${at}].lines`, (line, index) => count(line, `themes[${at}].lines[${index}]`, 1)),
  };
}

function decodeFieldError(value: unknown, at: number): TriageFieldErrorV1 {
  const row = keys(value, ['line', 'theme', 'field', 'value', 'fix'], `field_errors[${at}]`);
  return {
    line: count(row.line, `field_errors[${at}].line`, 1),
    theme: freeText(row.theme, `field_errors[${at}].theme`),
    field: text(row.field, `field_errors[${at}].field`),
    value: freeText(row.value, `field_errors[${at}].value`),
    fix: text(row.fix, `field_errors[${at}].fix`),
  };
}

function decodeEvidenceError(value: unknown, at: number): TriageEvidenceErrorV1 {
  const row = keys(value, ['theme', 'trigger'], `evidence_errors[${at}]`);
  return {
    theme: text(row.theme, `evidence_errors[${at}].theme`),
    trigger: text(row.trigger, `evidence_errors[${at}].trigger`),
  };
}

/** The helper reduces the entries to one row per theme key; a repeated key would break that reduction. */
function decodeThemes(value: unknown): readonly TriageThemeV1[] | null {
  if (value === null) return null;
  const themes = list(value, 'themes', decodeTheme);
  const seen = new Set<string>();
  for (const theme of themes) {
    if (seen.has(theme.key)) throw new Error(`rules triage invalid: duplicated theme ${theme.key}`);
    seen.add(theme.key);
  }
  return themes;
}

/**
 * Decode the document of `maintenance-triage --json`. The decoder refuses the
 * first field it cannot read, so a helper change never reaches a page as a
 * partly read state. `judgment` is the read model of another consumer; here it
 * is only checked to be null or a list of objects.
 */
export function decodeTriageReport(value: unknown): TriageReportV1 {
  const root = keys(value, ['judgment', 'themes', 'field_errors', 'evidence_errors'], 'document');
  if (root.judgment !== null && (!Array.isArray(root.judgment) || !root.judgment.every(isRecord))) {
    throw new Error('rules triage invalid: judgment');
  }
  return {
    judgment: root.judgment as readonly unknown[] | null,
    themes: decodeThemes(root.themes),
    field_errors: list(root.field_errors, 'field_errors', decodeFieldError),
    evidence_errors: list(root.evidence_errors, 'evidence_errors', decodeEvidenceError),
  };
}

/** The governance of a theme: a machine check, or judgment with and without a root promotion. */
export function ruleGovernance(theme: TriageThemeV1): RuleGovernance {
  if (theme.enforced_by !== JUDGMENT_ENFORCER) return 'structural';
  return theme.promoted === null ? 'judgment_unpromoted' : 'judgment_promoted';
}

/**
 * The open actions of a theme. `enforce` is open from a cumulative `Seen` of 2;
 * `promote_root` from 3 while no promotion is recorded. A theme with a machine
 * check has no action: its enforcement is the check, not a promotion.
 */
export function ruleActions(theme: TriageThemeV1): readonly RuleActionKind[] {
  if (theme.enforced_by !== JUDGMENT_ENFORCER) return [];
  const actions: RuleActionKind[] = [];
  if (theme.seen >= 2) actions.push('enforce');
  if (theme.seen >= 3 && theme.promoted === null) actions.push('promote_root');
  return actions;
}

/**
 * The one candidate identity: `sha256` hex of the domain line, the repository
 * identity, the theme key and the action, each on its own line. Every part is
 * newline-free, so the four lines cannot be confused with another input.
 */
export function candidateId(repositoryId: string, themeKey: string, action: RuleActionKind): string {
  for (const [label, part] of [['repository id', repositoryId], ['theme key', themeKey]] as const) {
    if (part.length === 0 || /[\r\n]/u.test(part)) throw new Error(`rules candidate: the ${label} must be one non-empty line`);
  }
  return sha256Hex([CANDIDATE_ID_DOMAIN, repositoryId, themeKey, action].join('\n'));
}

/**
 * Build the status document. On a field error the helper gives no theme
 * reduction, so `themes` is empty and `entries` is null. An evidence error
 * alone keeps every theme: the ledger is readable, one record of it is not.
 */
export function ruleStatus(report: TriageReportV1, repositoryId: string, ledger: RuleLedgerReadV1): RuleStatusV1 {
  const themes = (report.themes ?? [])
    .map((theme): RuleThemeV1 => ({
      ...theme,
      governance: ruleGovernance(theme),
      actions: ruleActions(theme).map((kind) => ({ kind, candidate_id: candidateId(repositoryId, theme.key, kind) })),
    }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return {
    kind: RULES_STATUS_KIND,
    protocol: RULES_STATUS_PROTOCOL,
    repository_id: repositoryId,
    ledger: {
      path: RULES_LEDGER_PATH,
      head: ledger.head,
      blob: ledger.blob,
      dirty: ledger.dirty,
      valid: report.field_errors.length === 0 && report.evidence_errors.length === 0,
      entries: report.themes === null ? null : report.themes.reduce((total, theme) => total + theme.lines.length, 0),
      field_errors: report.field_errors,
      evidence_errors: report.evidence_errors,
    },
    themes,
  };
}

/** The ledger state on one line, the error rows, then one line for each theme. */
export function describeRuleStatus(status: RuleStatusV1): string[] {
  const ledger = status.ledger;
  const state = [
    ledger.path,
    `head ${ledger.head.slice(0, 7)}`,
    `blob ${ledger.blob.slice(0, 7)}`,
    ledger.dirty ? 'dirty' : 'clean',
    ledger.valid ? 'valid' : 'invalid',
    ledger.entries === null ? 'entries unknown' : `${ledger.entries} ${ledger.entries === 1 ? 'entry' : 'entries'}`,
  ].join(' · ');
  return [
    state,
    ...ledger.field_errors.map((error) => `${ledger.path}:${error.line} ${error.theme}: ${error.field} ${JSON.stringify(error.value)}; ${error.fix}`),
    ...ledger.evidence_errors.map((error) => `${error.theme}: ${error.trigger}`),
    ...status.themes.map((theme) => [
      theme.key,
      `Seen ${theme.seen}×`,
      theme.governance,
      theme.actions.length === 0 ? 'no action' : theme.actions.map((action) => {
        if (action.task === undefined) return action.kind;
        if (action.task === null) return `${action.kind}: no task`;
        const task = action.task;
        return `${action.kind}: ${task.issue === null ? 'task' : `#${task.issue}`} ${task.progress}${task.reason ? ` (${task.reason})` : ''}`;
      }).join(', '),
    ].join(' · ')),
    ...(status.orchestration ? [`orchestration · parent ${status.orchestration.parent ?? 'none'} · plan ${status.orchestration.plan_comment} · coordinator ${status.orchestration.coordinator_claim}`] : []),
  ];
}
