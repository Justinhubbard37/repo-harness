/**
 * The plan block: one fenced JSON block in the newest `repo-harness plan`
 * comment on a parent issue. The coordinator is its only writer. GitHub owns
 * membership (sub-issues), dependencies (blocked-by) and tier (labels); the
 * block holds only what GitHub has no field for.
 */
export const PLAN_BLOCK_PROTOCOL = 2 as const;
export const PLAN_BLOCK_KIND = 'repo-harness.plan' as const;
/** The first line of a plan comment; `board.ts` and `board dispatch` read the newest one (`templates.md`, plan). */
export const PLAN_COMMENT_HEADER = 'repo-harness plan' as const;

/** The fields of one `plan` comment, as `templates.md` names them. `rh board post plan` renders them. */
export interface PlanCommentFieldsV1 {
  /** The comment URL of the coordinator claim. */
  readonly coordinator: string;
  /** `<branch>@<sha>`, the base that the plan was written against. */
  readonly baseline: string;
  /** The plan comment URL that this plan replaces; null on the first plan of a thread. */
  readonly supersedes: string | null;
  readonly block: PlanBlockV2;
}

export interface PlanHoldV1 {
  readonly issue: number;
  readonly reason: string;
}

export interface PlanBlockV2 {
  readonly protocol: typeof PLAN_BLOCK_PROTOCOL;
  readonly kind: typeof PLAN_BLOCK_KIND;
  /** Issue numbers in merge order. */
  readonly merge_order: readonly number[];
  readonly holds: readonly PlanHoldV1[];
  /** The most worker seats that run at the same time. */
  readonly seat_limits: { readonly worker: number };
}

export class PlanBlockError extends Error {
  constructor(message: string) {
    super(`plan block invalid: ${message}`);
    this.name = 'PlanBlockError';
  }
}

const FENCE = /^```json[ \t]*\n([\s\S]*?)\n```[ \t]*$/gmu;

function fail(message: string): never {
  throw new PlanBlockError(message);
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is not an object`);
  const actual = Object.keys(value).sort().join(',');
  if (actual !== [...keys].sort().join(',')) fail(`${label} fields are ${actual}, expected ${[...keys].sort().join(',')}`);
  return value as Record<string, unknown>;
}

function issueNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is not an issue number`);
  return value as number;
}

function issueList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  const numbers = value.map((entry, index) => issueNumber(entry, `${label}[${index}]`));
  if (new Set(numbers).size !== numbers.length) fail(`${label} repeats an issue`);
  return numbers;
}

/** Protocol and kind are checked first, so an unknown block is refused before any field is read. */
export function decodePlanBlockValue(value: unknown): PlanBlockV2 {
  const head = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (head.protocol !== PLAN_BLOCK_PROTOCOL) fail(`unsupported protocol ${JSON.stringify(head.protocol)}`);
  if (head.kind !== PLAN_BLOCK_KIND) fail(`unsupported kind ${JSON.stringify(head.kind)}`);
  const block = record(value, ['protocol', 'kind', 'merge_order', 'holds', 'seat_limits'], 'plan block');
  const mergeOrder = issueList(block.merge_order, 'merge_order');
  if (!Array.isArray(block.holds)) fail('holds is not an array');
  const holds = block.holds.map((entry, index) => {
    const hold = record(entry, ['issue', 'reason'], `holds[${index}]`);
    if (typeof hold.reason !== 'string' || hold.reason.trim() === '') fail(`holds[${index}].reason is empty`);
    return Object.freeze({ issue: issueNumber(hold.issue, `holds[${index}].issue`), reason: hold.reason });
  });
  if (new Set(holds.map(hold => hold.issue)).size !== holds.length) fail('holds repeats an issue');
  const limits = record(block.seat_limits, ['worker'], 'seat_limits');
  return Object.freeze({
    protocol: PLAN_BLOCK_PROTOCOL,
    kind: PLAN_BLOCK_KIND,
    merge_order: Object.freeze(mergeOrder),
    holds: Object.freeze(holds),
    seat_limits: Object.freeze({ worker: issueNumber(limits.worker, 'seat_limits.worker') }),
  });
}

/** The comment must hold exactly one fenced `json` block. */
export function decodePlanBlock(commentBody: string): PlanBlockV2 {
  const blocks = [...commentBody.replace(/\r\n/gu, '\n').matchAll(FENCE)];
  if (blocks.length !== 1) fail(`the plan comment has ${blocks.length} fenced json blocks, expected 1`);
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]![1]!);
  } catch {
    fail('the fenced block is not JSON');
  }
  return decodePlanBlockValue(value);
}

/** Every issue that the block names. */
export function planIssues(block: PlanBlockV2): ReadonlySet<number> {
  return new Set([...block.merge_order, ...block.holds.map(hold => hold.issue)]);
}

/** The plan comment of these fields: the header, the field lines, then exactly one fenced block. */
export function renderPlanComment(fields: PlanCommentFieldsV1): string {
  return [
    PLAN_COMMENT_HEADER,
    `Coordinator: ${fields.coordinator}`,
    `Baseline: ${fields.baseline}`,
    ...(fields.supersedes === null ? [] : [`Supersedes: ${fields.supersedes}`]),
    '', '```json', JSON.stringify(fields.block), '```',
  ].join('\n');
}
