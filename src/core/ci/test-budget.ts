/**
 * The `TestBudget` rule: the test lines and test files that a PR adds, measured
 * from the merge-base to the head, against the parameters of the base policy.
 * The result document is the contract of ADR-0004
 * (`docs/adr/ADR-0004-test-budget-result-contract.md`).
 */
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { canonicalize } from '../evidence/canonical-json';
import { sha256Prefixed } from '../evidence/sha256';
import {
  POLICY_ABSENT,
  WORKFLOW_POLICY_KEYS,
  isPolicyObject,
  policyValue,
  type DecodedWorkflowPolicy,
} from '../workflow/policy-schema';
import { RULES, type TestBudgetParameters } from './rules';

export const TEST_BUDGET_RESULT_SCHEMA = 'repo-harness/test-budget-result/v1';
/** Bump when a change to this file can change a result for the same inputs. */
export const TEST_BUDGET_IMPLEMENTATION_VERSION = 1;

// The policy key tree is the one list of keys; a key that the tree lacks fails the type check here.
const CONFIG_KEYS: Readonly<Record<'enabled' | keyof TestBudgetParameters, true>> = WORKFLOW_POLICY_KEYS.rules.TestBudget;

/** A disabled rule may carry no parameters; an enabled rule carries all of them. */
export type TestBudgetConfig =
  | ({ readonly enabled: true } & TestBudgetParameters)
  | ({ readonly enabled: false } & Partial<TestBudgetParameters>);

export type TestBudgetConfigRead =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly config: TestBudgetConfig }
  | { readonly status: 'invalid'; readonly message: string };

/** A path prefix: repository-relative segments, no glob or regular expression. */
const PATH_PREFIX = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/;

function invalid(message: string): TestBudgetConfigRead {
  return { status: 'invalid', message };
}

type Checked<Value> = { readonly value: Value } | string;

function pathList(key: string) {
  return (value: unknown): Checked<readonly string[]> => {
    if (!Array.isArray(value) || value.length === 0) return `rules.TestBudget.${key} must be a non-empty array of path prefixes`;
    for (const entry of value) {
      if (typeof entry !== 'string' || !PATH_PREFIX.test(entry)) {
        return `rules.TestBudget.${key} has an invalid path prefix ${JSON.stringify(entry)}`;
      }
    }
    if (new Set(value).size !== value.length) return `rules.TestBudget.${key} has a duplicate path prefix`;
    return { value: value as string[] };
  };
}

const PARAMETER_CHECKS: { readonly [Key in keyof TestBudgetParameters]: (value: unknown) => Checked<TestBudgetParameters[Key]> } = {
  ratio_cap: (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { value } : 'rules.TestBudget.ratio_cap must be a positive number'),
  file_cap: (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { value } : 'rules.TestBudget.file_cap must be a non-negative integer'),
  test_paths: pathList('test_paths'),
  product_paths: pathList('product_paths'),
};

/**
 * The rule configuration in a decoded policy. An absent `rules.TestBudget` is
 * "no configuration". A present one needs `enabled`. Each parameter it states
 * is checked; an enabled rule needs every parameter.
 */
export function readTestBudgetConfig(document: DecodedWorkflowPolicy): TestBudgetConfigRead {
  let value: unknown;
  try {
    value = policyValue(document, 'rules.TestBudget');
  } catch (error) {
    return invalid((error as Error).message);
  }
  if (value === POLICY_ABSENT) return { status: 'absent' };
  if (!isPolicyObject(value)) return invalid('rules.TestBudget must be an object');
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(CONFIG_KEYS, key)).sort();
  if (unknown.length > 0) return invalid(`rules.TestBudget has unknown fields: ${unknown.join(', ')}`);
  if (typeof value.enabled !== 'boolean') return invalid('rules.TestBudget.enabled must be true or false');
  const parameters: { -readonly [Key in keyof TestBudgetParameters]?: TestBudgetParameters[Key] } = {};
  for (const key of Object.keys(RULES.TestBudget.parameters) as (keyof TestBudgetParameters)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const checked = PARAMETER_CHECKS[key](value[key]);
    if (typeof checked === 'string') return invalid(checked);
    Object.assign(parameters, { [key]: checked.value });
  }
  if (!value.enabled) return { status: 'present', config: { enabled: false, ...parameters } };
  const missing = Object.keys(RULES.TestBudget.parameters).filter((key) => !Object.hasOwn(parameters, key));
  if (missing.length > 0) return invalid(`rules.TestBudget is enabled without: ${missing.join(', ')}`);
  return { status: 'present', config: { enabled: true, ...(parameters as TestBudgetParameters) } };
}

/** The digest of the effective configuration; "no configuration" digests `null`. */
export function testBudgetPolicyDigest(read: Exclude<TestBudgetConfigRead, { status: 'invalid' }>): string {
  return sha256Prefixed(canonicalize(read.status === 'present' ? read.config : null));
}

/**
 * One path of `git diff -M <merge-base> <head>`. The endpoints decide the
 * status: a file deleted and created again between them is `modified`.
 * `added_lines` is null for a binary file.
 */
export interface TestBudgetDiffEntry {
  readonly status: 'added' | 'modified' | 'renamed' | 'deleted';
  readonly path: string;
  readonly previous_path: string | null;
  readonly added_lines: number | null;
}

export interface TestBudgetMeasured {
  readonly added_test_lines: number;
  readonly added_product_lines: number;
  readonly added_test_files: number;
  /** Test lines per product line, rounded to two decimals; null when no product line is added. */
  readonly ratio: number | null;
  readonly ratio_cap: number;
  readonly file_cap: number;
}

function under(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * A test path wins over a product path. A binary file adds no line. A test file
 * counts as added when it is new, or renamed from a path outside the test paths.
 */
function measureTestBudget(entries: readonly TestBudgetDiffEntry[], config: TestBudgetParameters): TestBudgetMeasured {
  let testLines = 0;
  let productLines = 0;
  let testFiles = 0;
  for (const entry of entries) {
    if (entry.status === 'deleted') continue;
    const lines = entry.added_lines ?? 0;
    if (under(entry.path, config.test_paths)) {
      testLines += lines;
      const movedIn = entry.status === 'renamed' && !under(entry.previous_path!, config.test_paths);
      if (entry.status === 'added' || movedIn) testFiles += 1;
    } else if (under(entry.path, config.product_paths)) {
      productLines += lines;
    }
  }
  return {
    added_test_lines: testLines,
    added_product_lines: productLines,
    added_test_files: testFiles,
    ratio: productLines === 0 ? null : Math.round((testLines / productLines) * 100) / 100,
    ratio_cap: config.ratio_cap,
    file_cap: config.file_cap,
  };
}

/** Over the line budget (any test line without a product line counts), or over the file cap. */
function overTestBudget(measured: TestBudgetMeasured): boolean {
  const linesOver = measured.added_product_lines === 0
    ? measured.added_test_lines > 0
    : measured.added_test_lines > measured.ratio_cap * measured.added_product_lines;
  return linesOver || measured.added_test_files > measured.file_cap;
}

export interface TestBudgetExceptionCounts {
  readonly added_test_lines: number;
  readonly added_product_lines: number;
  readonly added_test_files: number;
}

export type TestBudgetException =
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly problem: string }
  | { readonly status: 'parsed'; readonly counts: TestBudgetExceptionCounts; readonly reason: string };

const EXCEPTION_HEADING = 'test budget exception';
const COUNT_LINE = /^(added test lines|added product lines|added test files):[ \t]*(\d+)$/i;
const COUNT_KEYS = {
  'added test lines': 'added_test_lines',
  'added product lines': 'added_product_lines',
  'added test files': 'added_test_files',
} as const satisfies Record<string, keyof TestBudgetExceptionCounts>;

/** The text of inline content; inline HTML (an HTML comment included) adds nothing. */
function inlineText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'break') return '\n';
  return 'children' in node ? node.children.map(inlineText).join('') : '';
}

type BodyItem =
  | { readonly kind: 'heading'; readonly depth: number; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'line'; readonly text: string; readonly quoted: boolean };

/**
 * The headings and text lines of the body in document order, at every nesting
 * depth: a heading inside a list item or a block quote is still a heading.
 * Code and HTML blocks hold no item. A line inside a block quote is `quoted`.
 */
function bodyItems(node: Nodes, quoted: boolean, out: BodyItem[]): void {
  if (node.type === 'heading') {
    out.push({ kind: 'heading', depth: node.depth, text: inlineText(node), quoted });
  } else if (node.type === 'paragraph' || node.type === 'tableCell') {
    for (const text of inlineText(node).split('\n')) out.push({ kind: 'line', text, quoted });
  } else if (node.type !== 'code' && node.type !== 'html' && 'children' in node) {
    for (const child of node.children) bodyItems(child, quoted || node.type === 'blockquote', out);
  }
}

/**
 * The `## Test budget exception` section of a PR body, read from one CommonMark
 * parse: a level-2 heading with that text, up to the next level 1 or 2 heading
 * in document order, also one nested in a list item or a block quote. A heading
 * inside fenced code, an HTML comment or a block quote is not the section. The
 * section needs each count line once; its other text lines are the reason, and
 * a quoted line is never a count.
 */
export function parseTestBudgetException(body: string): TestBudgetException {
  const items: BodyItem[] = [];
  bodyItems(fromMarkdown(body), false, items);
  const starts = items.flatMap((item, index) => (item.kind === 'heading' && item.depth === 2 && !item.quoted
    && item.text.replace(/\s+/g, ' ').trim().toLowerCase() === EXCEPTION_HEADING ? [index] : []));
  if (starts.length === 0) return { status: 'absent' };
  if (starts.length > 1) return { status: 'malformed', problem: 'the PR body has more than one Test budget exception section' };
  const counts: Partial<Record<keyof TestBudgetExceptionCounts, number>> = {};
  const reason: string[] = [];
  for (const item of items.slice(starts[0]! + 1)) {
    if (item.kind === 'heading' && item.depth <= 2) break;
    for (const line of item.text.split('\n').map((text) => text.trim())) {
      const count = item.quoted ? null : COUNT_LINE.exec(line);
      if (count === null) {
        if (line !== '') reason.push(line);
        continue;
      }
      const key = COUNT_KEYS[count[1]!.toLowerCase() as keyof typeof COUNT_KEYS];
      const value = Number(count[2]);
      if (counts[key] !== undefined) return { status: 'malformed', problem: `the section states "${count[1]}" more than once` };
      if (!Number.isSafeInteger(value)) return { status: 'malformed', problem: `the section has an invalid number for "${count[1]}"` };
      counts[key] = value;
    }
  }
  const missing = Object.entries(COUNT_KEYS).filter(([, key]) => counts[key] === undefined).map(([label]) => label);
  if (missing.length > 0) return { status: 'malformed', problem: `the section has no line for: ${missing.join(', ')}` };
  return {
    status: 'parsed',
    counts: {
      added_test_lines: counts.added_test_lines!,
      added_product_lines: counts.added_product_lines!,
      added_test_files: counts.added_test_files!,
    },
    reason: reason.join('\n'),
  };
}

/** The digest of the parsed counts and reason; null when the body has no parsed section. */
export function testBudgetExceptionDigest(exception: TestBudgetException): string | null {
  if (exception.status !== 'parsed') return null;
  return sha256Prefixed(canonicalize({ counts: exception.counts, reason: exception.reason }));
}

export interface TestBudgetBound {
  readonly head_sha: string;
  readonly diff_start: string;
  readonly policy_digest: string;
  readonly implementation_version: number;
  readonly exception_digest: string | null;
}

export interface TestBudgetExceptionResult {
  readonly present: boolean;
  readonly valid: boolean;
  readonly counts: TestBudgetExceptionCounts | null;
  readonly reason: string | null;
}

/**
 * `measured`, `over_budget` and `exception` are null for `skipped` (nothing is
 * measured) and for `error`. An `error` result keeps null for each bound input
 * that the rule could not compute.
 */
export type TestBudgetResult =
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'pass' | 'violation';
    readonly bound: TestBudgetBound;
    readonly measured: TestBudgetMeasured;
    readonly over_budget: boolean;
    readonly exception: TestBudgetExceptionResult;
    readonly error: null;
  }
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'skipped';
    readonly bound: TestBudgetBound;
    readonly measured: null;
    readonly over_budget: null;
    readonly exception: null;
    readonly error: null;
  }
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'error';
    readonly bound: { readonly [Key in keyof TestBudgetBound]: TestBudgetBound[Key] | null };
    readonly measured: null;
    readonly over_budget: null;
    readonly exception: null;
    readonly error: { readonly code: string; readonly message: string };
  };

function exceptionMatches(exception: TestBudgetException, measured: TestBudgetMeasured): boolean {
  return exception.status === 'parsed'
    && exception.reason !== ''
    && exception.counts.added_test_lines === measured.added_test_lines
    && exception.counts.added_product_lines === measured.added_product_lines
    && exception.counts.added_test_files === measured.added_test_files;
}

/**
 * Over budget with a valid exception is `pass`; the measured numbers stay as
 * measured. A disabled rule is `skipped` and measures nothing.
 */
export function evaluateTestBudget(input: {
  readonly head_sha: string;
  readonly diff_start: string;
  readonly config: Exclude<TestBudgetConfigRead, { status: 'invalid' }>;
  readonly entries: readonly TestBudgetDiffEntry[];
  readonly exception: TestBudgetException;
}): TestBudgetResult {
  const bound: TestBudgetBound = {
    head_sha: input.head_sha,
    diff_start: input.diff_start,
    policy_digest: testBudgetPolicyDigest(input.config),
    implementation_version: TEST_BUDGET_IMPLEMENTATION_VERSION,
    exception_digest: testBudgetExceptionDigest(input.exception),
  };
  if (input.config.status === 'absent' || !input.config.config.enabled) {
    return { schema: TEST_BUDGET_RESULT_SCHEMA, state: 'skipped', bound, measured: null, over_budget: null, exception: null, error: null };
  }
  const measured = measureTestBudget(input.entries, input.config.config);
  const overBudget = overTestBudget(measured);
  const valid = exceptionMatches(input.exception, measured);
  const parsed = input.exception.status === 'parsed' ? input.exception : null;
  return {
    schema: TEST_BUDGET_RESULT_SCHEMA,
    state: overBudget && !valid ? 'violation' : 'pass',
    bound,
    measured,
    over_budget: overBudget,
    exception: {
      present: input.exception.status !== 'absent',
      valid,
      counts: parsed?.counts ?? null,
      reason: parsed?.reason ?? null,
    },
    error: null,
  };
}

export function testBudgetError(
  bound: { readonly [Key in keyof TestBudgetBound]: TestBudgetBound[Key] | null },
  code: string,
  message: string,
): TestBudgetResult {
  return { schema: TEST_BUDGET_RESULT_SCHEMA, state: 'error', bound, measured: null, over_budget: null, exception: null, error: { code, message } };
}

/** Human lines for the job log. They never repeat PR body text. */
export function describeTestBudget(result: TestBudgetResult, exception: TestBudgetException): string[] {
  if (result.state === 'error') return [`TestBudget error (${result.error.code}): ${result.error.message}`];
  if (result.state === 'skipped') return ['TestBudget skipped: the base policy does not enable the rule.'];
  const { measured } = result;
  const lines = [`TestBudget ${result.state}: ${measured.added_test_lines} added test lines, ${measured.added_product_lines} added product lines, `
    + `${measured.added_test_files} added test files (ratio cap ${measured.ratio_cap}, file cap ${measured.file_cap}).`];
  if (result.state === 'pass') return result.over_budget ? [...lines, 'Over budget; the exception is valid.'] : lines;
  if (exception.status === 'absent') lines.push('The PR body has no Test budget exception section.');
  if (exception.status === 'malformed') lines.push(`The exception is invalid: ${exception.problem}.`);
  if (exception.status === 'parsed' && exception.reason === '') lines.push('The exception is invalid: the reason is empty.');
  if (exception.status === 'parsed' && exception.reason !== '' && !result.exception.valid) {
    lines.push('The exception is invalid: its numbers differ from the measured numbers.');
  }
  return [...lines, RULES.TestBudget.repair];
}

/** A GitHub Actions workflow command for one `notice` annotation; the escapes keep it one command line. */
export function githubNoticeCommand(title: string, message: string): string {
  const data = (value: string) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (value: string) => data(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::notice title=${property(title)}::${data(message)}`;
}
