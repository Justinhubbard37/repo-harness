import { planFromComments } from './board';
import { decodePlanBlock, decodePlanBlockValue, PLAN_COMMENT_HEADER, renderPlanComment, type PlanBlockV2, type PlanCommentFieldsV1 } from './plan-block';
import {
  MERGE_HOLD_HEADER,
  MERGE_HOLD_RELEASED_HEADER,
  readMergeHold,
  renderMergeHoldComment,
  renderMergeHoldReleaseComment,
  type MergeHoldCommentFieldsV1,
  type MergeHoldReleaseCommentFieldsV1,
} from './merge';
import {
  ACCEPTANCE_DISPOSITION_HEADER,
  BOUNDARY_QUESTION_HEADER,
  commentId,
  openQuestions,
  parseAcceptanceDisposition,
  protocolComments,
  renderAcceptanceDispositionComment,
  renderBoundaryQuestionComment,
  type AcceptanceDispositionCommentFieldsV1,
  type BoardCommentPageV1,
  type BoardCommentV1,
  type BoundaryQuestionCommentFieldsV1,
} from './source';

/**
 * `rh board post`: the protocol comments that the board parses, written from a JSON fields object. Each kind renders one comment
 * next to its parser, and the existing parser decodes the rendered text before anything is posted. A comment is posted only after
 * its own parser accepts the text, so `rh board --parent <n>` never fails on a plan that this command wrote.
 */
export const BOARD_POST_KINDS = ['plan', 'hold', 'release', 'disposition', 'question'] as const;
export type BoardPostKind = typeof BOARD_POST_KINDS[number];

/** An unknown key, a missing required field or a wrong type. Nothing is posted. The message is `<key>: <reason>`. */
export class BoardPostFieldsError extends Error {
  readonly code = 'board_post_fields_invalid' as const;
  constructor(readonly key: string, reason: string) {
    super(`${key}: ${reason}`);
    this.name = 'BoardPostFieldsError';
  }
}

/** The rendered text that the kind's own parser refuses. Nothing is posted. */
export class BoardPostRoundtripError extends Error {
  readonly code = 'board_post_roundtrip_failed' as const;
  constructor(readonly kind: BoardPostKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = 'BoardPostRoundtripError';
  }
}

/** The target thread already holds a plan and the fields name no `supersedes`. Nothing is posted. */
export class BoardPostSupersedesError extends Error {
  readonly code = 'board_post_supersedes_required' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'BoardPostSupersedesError';
  }
}

/** The validated fields of one comment, tagged with its kind. `renderPostBody` and `checkPostBody` take this value. */
export type BoardPostFieldsV1 =
  | { readonly kind: 'plan'; readonly fields: PlanCommentFieldsV1 }
  | { readonly kind: 'hold'; readonly fields: MergeHoldCommentFieldsV1 }
  | { readonly kind: 'release'; readonly fields: MergeHoldReleaseCommentFieldsV1 }
  | { readonly kind: 'disposition'; readonly fields: AcceptanceDispositionCommentFieldsV1 }
  | { readonly kind: 'question'; readonly fields: BoundaryQuestionCommentFieldsV1 };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A field that the template names, with the reason that a present value is refused. */
interface FieldSpec {
  readonly required: boolean;
  readonly refuse?: (value: unknown) => string | null;
}

const issueNumberList = (value: unknown): string | null => Array.isArray(value) && value.every(entry => Number.isSafeInteger(entry) && (entry as number) > 0)
  ? null : 'not a list of issue numbers';
const findingList = (value: unknown): string | null => Array.isArray(value) && value.length > 0
  && value.every(entry => typeof entry === 'string' && entry.trim() !== '' && !entry.includes(','))
  ? null : 'not a non-empty list of finding ids, none with a comma';
const baseline = (value: unknown): string | null => typeof value === 'string' && /^\S+@[0-9a-f]{7,40}$/u.test(value) ? null : 'not <branch>@<sha>';
const commentUrl = (value: unknown): string | null => (typeof value === 'string' && commentId(value) !== null ? null : 'not a comment URL');

/** Every field of each kind, keyed as `templates.md` names them. `plan` adds `block`, the plan block object. */
const KINDS: Readonly<Record<BoardPostKind, Readonly<Record<string, FieldSpec>>>> = {
  plan: { coordinator: { required: true, refuse: commentUrl }, baseline: { required: true, refuse: baseline }, supersedes: { required: false, refuse: commentUrl }, block: { required: true } },
  hold: { issues: { required: false, refuse: issueNumberList }, reason: { required: true } },
  release: { reason: { required: true } },
  disposition: {
    record: { required: true, refuse: commentUrl },
    subject: { required: true, refuse: value => (typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value) ? null : 'not a 40-hex subject sha') },
    findings: { required: true, refuse: findingList },
    decision: { required: true, refuse: commentUrl },
  },
  question: {
    to: { required: true, refuse: value => (value === 'coordinator' ? null : 'not coordinator') },
    claim: { required: true }, blocker: { required: true }, evidence: { required: true }, options: { required: true }, holding: { required: true },
  },
};

/** The comment header of each kind; the roundtrip check reads it back from the rendered text. */
const POST_HEADERS: Readonly<Record<BoardPostKind, string>> = {
  plan: PLAN_COMMENT_HEADER, hold: MERGE_HOLD_HEADER, release: MERGE_HOLD_RELEASED_HEADER,
  disposition: ACCEPTANCE_DISPOSITION_HEADER, question: BOUNDARY_QUESTION_HEADER,
};

function parseKind(value: string): BoardPostKind {
  const kind = BOARD_POST_KINDS.find(candidate => candidate === value);
  if (kind === undefined) throw new BoardPostFieldsError('kind', `not one of ${BOARD_POST_KINDS.join(', ')}`);
  return kind;
}

/** A required one-line field value: absent, empty, of another type, or with a line break is refused. */
function text(body: Record<string, unknown>, key: string, spec: FieldSpec): string {
  const value = body[key];
  if (value === undefined || value === null) throw new BoardPostFieldsError(key, 'required');
  if (typeof value !== 'string') throw new BoardPostFieldsError(key, 'not a string');
  if (value.trim() === '') throw new BoardPostFieldsError(key, 'empty');
  const refused = spec.refuse?.(value);
  if (refused !== null && refused !== undefined) throw new BoardPostFieldsError(key, refused);
  // Each field is one `Field: value` line, so a line break would put text outside the field that the parser reads.
  if (/[\r\n]/u.test(value)) throw new BoardPostFieldsError(key, 'holds a line break; each field is one line');
  return value.trim();
}

/** An optional value of any shape, refused by the spec when it is present. */
function optional<T>(body: Record<string, unknown>, key: string, spec: FieldSpec): T | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  const refused = spec.refuse?.(value);
  if (refused !== null && refused !== undefined) throw new BoardPostFieldsError(key, refused);
  return value as T;
}

function requiredList(body: Record<string, unknown>, key: string, spec: FieldSpec): readonly string[] {
  const value = body[key];
  if (value === undefined || value === null) throw new BoardPostFieldsError(key, 'required');
  const refused = spec.refuse?.(value);
  if (refused !== null && refused !== undefined) throw new BoardPostFieldsError(key, refused);
  return Object.freeze((value as readonly string[]).map(entry => entry.trim()));
}

/** The plan block of the fields, through the block decoder that the board itself uses. */
function planBlock(body: Record<string, unknown>): PlanBlockV2 {
  const value = body.block;
  if (value === undefined || value === null) throw new BoardPostFieldsError('block', 'required');
  try {
    return decodePlanBlockValue(value);
  } catch (error) {
    throw new BoardPostFieldsError('block', (error as Error).message);
  }
}

/**
 * The fields of one comment, from the JSON object of `--fields-file`. Every key is a field of the template in `templates.md`,
 * or `block` for `plan`. An unknown key, a missing required field or a wrong type throws `BoardPostFieldsError` before anything is
 * posted.
 */
export function decodePostFields(kindName: string, value: unknown): BoardPostFieldsV1 {
  const kind = parseKind(kindName);
  const specs = KINDS[kind];
  if (!isRecord(value)) throw new BoardPostFieldsError('fields', 'not a JSON object');
  for (const key of Object.keys(value)) if (specs[key] === undefined) throw new BoardPostFieldsError(key, 'not a field of this kind');
  switch (kind) {
    case 'plan':
      return { kind, fields: Object.freeze({
        coordinator: text(value, 'coordinator', specs.coordinator!), baseline: text(value, 'baseline', specs.baseline!),
        supersedes: optional<string>(value, 'supersedes', specs.supersedes!), block: planBlock(value),
      }) };
    case 'hold':
      return { kind, fields: Object.freeze({
        issues: optional<readonly number[]>(value, 'issues', specs.issues!), reason: text(value, 'reason', specs.reason!),
      }) };
    case 'release':
      return { kind, fields: Object.freeze({ reason: text(value, 'reason', specs.reason!) }) };
    case 'disposition':
      return { kind, fields: Object.freeze({
        record: text(value, 'record', specs.record!), subject: text(value, 'subject', specs.subject!),
        findings: requiredList(value, 'findings', specs.findings!), decision: text(value, 'decision', specs.decision!),
      }) };
    case 'question':
      return { kind, fields: Object.freeze({
        to: text(value, 'to', specs.to!) as 'coordinator', claim: text(value, 'claim', specs.claim!),
        blocker: text(value, 'blocker', specs.blocker!), evidence: text(value, 'evidence', specs.evidence!),
        options: text(value, 'options', specs.options!), holding: text(value, 'holding', specs.holding!),
      }) };
  }
}

/** The comment text of one kind, from its validated fields. */
export function renderPostBody(post: BoardPostFieldsV1): string {
  switch (post.kind) {
    case 'plan': return renderPlanComment(post.fields);
    case 'hold': return renderMergeHoldComment(post.fields);
    case 'release': return renderMergeHoldReleaseComment(post.fields);
    case 'disposition': return renderAcceptanceDispositionComment(post.fields);
    case 'question': return renderBoundaryQuestionComment(post.fields);
  }
}

/** One comment as a reader sees it, for the parsers that take a page. */
const posted = (body: string, at: string): BoardCommentV1 => Object.freeze({ url: 'https://github.com/o/r/issues/1#issuecomment-1', created_at: at, author_association: 'OWNER', body });
const page = (comments: readonly BoardCommentV1[]): BoardCommentPageV1 => Object.freeze({ truncated: false, comments: Object.freeze(comments) });

/**
 * Decode the rendered comment with the parser of its kind, and compare the values that the parser returns with the fields. A comment
 * that its own parser refuses, or reads back with another value, throws `BoardPostRoundtripError`, so `rh board` cannot meet a plan or
 * a hold that this command wrote.
 */
export function checkPostBody(post: BoardPostFieldsV1, body: string): void {
  const header = body.replace(/\r\n/gu, '\n').split('\n', 1)[0]!.trim();
  if (header !== POST_HEADERS[post.kind]) throw new BoardPostRoundtripError(post.kind, `the first line is ${JSON.stringify(header)}`);
  const disagree = (what: string): never => { throw new BoardPostRoundtripError(post.kind, `${what} reads back with another value`); };
  switch (post.kind) {
    case 'plan': {
      let block: PlanBlockV2;
      try { block = decodePlanBlock(body); } catch (error) { throw new BoardPostRoundtripError(post.kind, (error as Error).message); }
      if (JSON.stringify(block) !== JSON.stringify(post.fields.block)) disagree('the plan block');
      return;
    }
    case 'hold': {
      const hold = readMergeHold(page([posted(body, '2026-01-01T00:00:00Z')]), post.fields.issues !== null);
      if (hold.status !== 'held' || hold.holds.length !== 1) return disagree('the hold');
      const read = hold.holds[0]!.issues;
      if (post.fields.issues !== null && (read === null || read.join(',') !== post.fields.issues.join(','))) return disagree('the `Issues:` line');
      return;
    }
    case 'release': {
      // The release ends a hold that it is strictly newer than; the parser is the judge of the two comment times.
      const released = readMergeHold(page([posted('repo-harness merge hold\nReason: earlier', '2026-01-01T00:00:00Z'), posted(body, '2026-01-02T00:00:00Z')]), true);
      if (released.status !== 'none') return disagree('the release');
      return;
    }
    case 'disposition': {
      const parsed = parseAcceptanceDisposition(posted(body, '2026-01-01T00:00:00Z'));
      if (parsed === null) return disagree('the disposition');
      if (parsed.subject_sha !== post.fields.subject || parsed.findings.join(',') !== post.fields.findings.join(',')
        || parsed.record !== commentId(post.fields.record)) return disagree('the disposition');
      return;
    }
    case 'question': {
      const questions = openQuestions(page([posted(body, '2026-01-01T00:00:00Z')]));
      if (questions.status !== 'observed' || questions.questions.length !== 1) return disagree('the question');
      return;
    }
  }
}

/** The plan comments of a thread, oldest first: the URLs that a `supersedes` field may name. */
export function planCommentUrls(page: BoardCommentPageV1): readonly string[] {
  return protocolComments(page, POST_HEADERS.plan).map(comment => comment.url);
}

/**
 * The `supersedes` rule of `plan`: a thread that already holds a plan takes a new plan only with `Supersedes:`, and that URL must name
 * a plan comment of the same thread. The rule reads the plan with `planFromComments`, the same read that the board uses. `truncated`:
 * the read did not return every comment, so the rule fails closed.
 */
export function checkPlanSupersedes(fields: PlanCommentFieldsV1, thread: BoardCommentPageV1): void {
  const plan = planFromComments(thread);
  if (plan.status === 'absent') {
    // An absent plan under a truncated read can still be an older comment that the read did not return.
    if (thread.truncated) throw new BoardPostFieldsError('supersedes', 'the comment read was truncated, so an older plan comment is unknown');
    if (fields.supersedes === null) return;
    throw new BoardPostFieldsError('supersedes', 'the thread holds no plan comment to supersede');
  }
  if (fields.supersedes === null) {
    const of = plan.status === 'observed' ? `the plan ${plan.comment_url}` : `a plan at ${plan.comment_url} that does not decode`;
    throw new BoardPostSupersedesError(`the thread already holds ${of}; name it in supersedes${thread.truncated ? ' (the comment read was truncated, so older plan comments are unknown)' : ''}`);
  }
  const plans = planCommentUrls(thread);
  if (!plans.includes(fields.supersedes)) throw new BoardPostFieldsError('supersedes', `not a plan comment URL of this thread: ${plans.join(', ')}`);
  if (thread.truncated) throw new BoardPostFieldsError('supersedes', 'the comment read was truncated, so an older plan comment is unknown');
}
