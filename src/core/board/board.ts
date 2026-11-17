import { parseClosingReferences } from '../publication/closing-references';
import type { AcceptanceMergeSwitch } from '../publication/acceptance-merge-policy';
import type { PullRequestReadinessV2 } from '../publication/merge-readiness';
import { isSeatStatusMessage, seatStatusMessage } from './advisor-seat';
import { readMergeHold, type BoardMergeHoldV1 } from './merge';
import { decodePlanBlock, PlanBlockError, PLAN_COMMENT_HEADER, type PlanBlockV2 } from './plan-block';
import {
  issueClaim,
  openQuestions,
  newestProtocolComment,
  parseClaimStatus,
  parseRefs,
  protocolComments,
  type BoardCommentPageV1,
  type BoardParentReadV1,
  type BoardPullRequestReadV1,
  type BoardSubIssueReadV1,
  type ClaimStatusV1,
  type IssueClaimV1,
  type OpenQuestionsV1,
} from './source';
import { isCiRepairIssueBody } from '../ci/test-report';
import {
  acceptance,
  effectiveTier,
  gatekeeperReview,
  requiredCheck,
  reviewFail,
  reviewRecords,
  reviewRule,
  secondReview,
  tierOf,
  writerFamily,
  type BoardAcceptanceV1,
  type BoardGatekeeperReviewV1,
  type BoardRequiredCheckV1,
  type BoardRequiredContextsV1,
  type BoardReviewRecordsV1,
  type BoardSecondReviewV1,
  type BoardTier,
  type BoardWriterFamily,
} from './review-rules';

export { ACCEPTANCE_RECORD_HEADER } from './review-rules';
export type {
  BoardAcceptanceV1,
  BoardGatekeeperReviewV1,
  BoardRequiredCheckV1,
  BoardRequiredContextV1,
  BoardRequiredContextsV1,
  BoardReviewRecordsV1,
  BoardSecondReviewV1,
  BoardTier,
  BoardWriterFamily,
} from './review-rules';

/**
 * The board: one parent issue, its sub-issues and their pull requests, the
 * hc seat terminals that work on them, the daily full run and the hc pin.
 * It is a read model. GitHub and hc stay the authorities; the board keeps
 * their observation time and never writes back.
 */
export const BOARD_PROTOCOL = 12 as const;
export const BOARD_KIND = 'repo-harness.board' as const;

const PLAN_HEADER = PLAN_COMMENT_HEADER;
const CLAIM_STATUS_HEADER = 'repo-harness issue claim status';

export type BoardPlanV1 =
  /** `revision`: the ordinal of this comment among the parent's plan comments (r1 is the first); null when the comment read is truncated. */
  | { readonly status: 'observed'; readonly comment_url: string; readonly created_at: string; readonly revision: number | null; readonly block: PlanBlockV2 }
  | { readonly status: 'absent'; readonly truncated: boolean }
  | { readonly status: 'unavailable'; readonly comment_url: string; readonly reason: string };

export type BoardClaimStatusV1 =
  | ({ readonly status_kind: 'observed' } & ClaimStatusV1)
  | { readonly status_kind: 'none' }
  /** Older comments exist that the read did not return, and the newest ones hold no status. */
  | { readonly status_kind: 'unknown' };

export interface BoardItemV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly tier: BoardTier | null;
  readonly milestone: string | null;
  readonly blocked_by: readonly { readonly number: number; readonly state: 'open' | 'closed' }[];
  readonly claim: IssueClaimV1;
  readonly claim_status: BoardClaimStatusV1;
  readonly open_questions: OpenQuestionsV1;
  /** Pull requests whose body closes or refs this issue. */
  readonly pull_requests: readonly number[];
  readonly merge_hold: BoardMergeHoldV1;
}

export interface BoardPullRequestV1 {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly is_draft: boolean;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly head_committed_at: string;
  readonly merged_at: string | null;
  readonly closes: readonly number[];
  readonly refs: readonly number[];
  readonly files: readonly string[] | null;
  readonly required_check: BoardRequiredCheckV1;
  readonly acceptance: BoardAcceptanceV1;
  /** The newest acceptance record with a FAIL row for the head that no disposition resolves; `recorded_at` is the record's comment time. */
  readonly review_fail: { readonly url: string; readonly recorded_at: string } | null;
  readonly review_records: BoardReviewRecordsV1;
  readonly open_questions: OpenQuestionsV1;
  /** The single-PR readiness projection, for open pull requests only. */
  readonly merge_readiness: PullRequestReadinessV2 | null;
  /** The read time of `merge_readiness`: a stored answer keeps the time of its read. Null when `merge_readiness` is null. */
  readonly merge_readiness_observed_at: string | null;
  /** `high` when a changed path is on the High list or the change hazard list, or the file list is incomplete; otherwise the highest review tier of the linked issues (the parent excluded), null when the pull request links none, or one is outside the board or has no tier label; `medium` for Low labels on a fix of more than 50 changed lines or of unknown size. */
  readonly tier: BoardTier | null;
  /**
   * An unknown tier counts as High here (fail closed). `pending`: an open High pull request whose head does not meet the High acceptance rule and has no acceptance row
   * of the configured reviewer's model family (`BoardV1.reviewer_family`). `recorded`: such a row exists. `not_required` for any other pull request, and for a High head that meets the rule without such a row.
   */
  readonly second_review: BoardSecondReviewV1;
  /** `gatekeeperReview`: the verdict of the rows of the head that are not the reviewer's, which opens the relay of the second review. */
  readonly gatekeeper_review: BoardGatekeeperReviewV1;
  /**
   * The family of the `Runtime:` that the newest writer claim bound to the head branch names, the same on every linked issue (the parent
   * excluded); null when a linked issue has no such claim, a runtime names no family, or the issues disagree. It selects the Medium review
   * seat only: the record's `Model relation:` line stays the authority of acceptance.
   */
  readonly writer_family: BoardWriterFamily | null;
  readonly merge_hold: BoardMergeHoldV1;
}

export type BoardTerminalV1 = {
  readonly address: string;
  readonly name: string | null;
  readonly agent: string | null;
  readonly state: 'live' | 'finished';
  /** The program's own 7501 word; null when it never reported. */
  readonly status: string | null;
  readonly status_kind: string | null;
  /** hc `status.msg` as one redacted line (`seatStatusMessage`); null when the status has no message. */
  readonly status_msg: string | null;
  readonly status_ms: number | null;
  readonly turn: number;
  /** The current branch of the terminal's working directory; null for a detached HEAD, a missing directory or a failed read. */
  readonly branch: string | null;
} & (
  | { readonly seat_status: 'observed'; readonly seat: string; readonly issue: number | null; readonly pr: number | null }
  /** The terminal carries the parent label but no seat label. The board does not guess its seat. */
  | { readonly seat_status: 'unavailable'; readonly reason: 'seat_label_missing' | 'seat_label_invalid' }
);

/** One terminal as the host reads it: the seat labels are raw label values, checked by the board collector. */
export interface BoardSeatTerminalReadV1 {
  readonly address: string;
  readonly name: string | null;
  readonly agent: string | null;
  readonly state: 'live' | 'finished';
  readonly status: string | null;
  readonly status_kind: string | null;
  /** The raw hc `status.msg`. `seatTerminal` redacts it before it leaves the host read. */
  readonly status_msg: string | null;
  readonly status_ms: number | null;
  readonly turn: number;
  /** The working directory that hc reports, when it reports one. */
  readonly cwd: string | null;
  readonly labels: { readonly seat?: string; readonly issue?: string; readonly pr?: string; readonly parent?: string };
}

/** A read terminal with its branch in place of its directory: the board carries no machine-local path (ADR-0002). */
export type BoardSeatTerminalInputV1 = Omit<BoardSeatTerminalReadV1, 'cwd'> & { readonly branch: string | null };

const POSITIVE = /^[1-9][0-9]*$/u;

/** The board's one check of the raw seat, issue and pr labels of a terminal (the board and the parent list). */
export function seatTerminal(terminal: BoardSeatTerminalInputV1): BoardTerminalV1 {
  const { labels, status_msg, ...rest } = terminal;
  const base = { ...rest, status_msg: seatStatusMessage(status_msg) };
  const { seat, issue, pr } = labels;
  if (seat === undefined) return { ...base, seat_status: 'unavailable', reason: 'seat_label_missing' };
  if (seat === '' || [issue, pr].some(value => value !== undefined && !POSITIVE.test(value))) {
    return { ...base, seat_status: 'unavailable', reason: 'seat_label_invalid' };
  }
  return { ...base, seat_status: 'observed', seat, issue: issue === undefined ? null : Number(issue), pr: pr === undefined ? null : Number(pr) };
}

/**
 * The host reads that the board needs, as a core contract. The terminal host
 * is a plugin, so only the composition root (`src/cli/index.ts`) passes its
 * implementation in.
 */
export interface BoardHostPortsV1 {
  /**
   * The terminals that carry the repository label (the GitHub numeric
   * repository id, decimal), with their raw parent label; watcher terminals
   * are left out. One hc core can host seats of several repositories that
   * share a parent number. The board selects the seats of one parent; the
   * parent list keeps every seat of the repository.
   */
  readonly seatTerminals: (repositoryId: string) =>
    | { readonly status: 'observed'; readonly terminals: readonly BoardSeatTerminalReadV1[] }
    | { readonly status: 'unavailable'; readonly reason: string };
  /** `seatTerminals` with finished terminals too (`hc ls --all`). Only the post-merge closeout reads it, to remove a finished seat terminal (#2021). */
  readonly closeoutTerminals: BoardHostPortsV1['seatTerminals'];
  /** The installed hc client version, `x.y.z`. */
  readonly hcVersion: () => { readonly status: 'observed'; readonly version: string } | { readonly status: 'unavailable'; readonly reason: string };
  /** `hc send` of plain text to the advisor terminal that the caller resolved from `seatTerminals` (#1756). */
  readonly advisorSend: (address: string, text: string) =>
    | { readonly status: 'sent'; readonly started: boolean | null; readonly turn: number }
    | { readonly status: 'unavailable'; readonly reason: string };
  /** `hc read --lines <lines>` of the advisor terminal that the caller resolved from `seatTerminals` (#1756). */
  readonly advisorRead: (address: string, lines: number) =>
    | { readonly status: 'observed'; readonly text: string; readonly complete: boolean; readonly why: string | null }
    | { readonly status: 'unavailable'; readonly reason: string };
  /** `hc kill`, then `hc rm`, of a seat terminal that the post-merge closeout resolved from `closeoutTerminals` (#2005). */
  readonly closeTerminal: (address: string) =>
    | { readonly status: 'closed' }
    | { readonly status: 'unavailable'; readonly reason: string };
}

export type BoardExecutionV1 =
  | { readonly status: 'observed'; readonly terminals: readonly BoardTerminalV1[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export type BoardDailyRunV1 =
  | { readonly status: 'observed'; readonly run_url: string; readonly conclusion: string | null; readonly created_at: string; readonly open_repair_issues: readonly number[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** The owning capability of one changed path, as `archctx resolve` reports it. The board never guesses an owner. */
export type BoardPathOwnerV1 =
  | { readonly path: string; readonly status: 'owned'; readonly capability: string }
  | { readonly path: string; readonly status: 'unowned' | 'ambiguous' };

/** One entry for each changed path of each open pull request with a complete file list, sorted by path. */
export type BoardPathOwnersV1 =
  | { readonly status: 'observed'; readonly owners: readonly BoardPathOwnerV1[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** `publication.acceptance_merge` on the default branch; `unknown` when the policy file could not be read or decoded. */
export type BoardAcceptanceMergeV1 = AcceptanceMergeSwitch | 'unknown';

export interface BoardToolingV1 {
  readonly hc: { readonly status: 'observed'; readonly version: string; readonly min_version: string } | { readonly status: 'unavailable'; readonly reason: string };
  /** No policy pin exists for Herdr.app yet. */
  readonly herdr_app: { readonly status: 'not_pinned' };
}

export interface BoardV1 {
  readonly protocol: typeof BOARD_PROTOCOL;
  readonly kind: typeof BOARD_KIND;
  readonly observed_at: string;
  readonly repository: string;
  readonly default_branch: string;
  readonly acceptance_merge: BoardAcceptanceMergeV1;
  readonly parent: { readonly number: number; readonly title: string; readonly url: string; readonly state: 'open' | 'closed'; readonly labels: readonly string[]; readonly milestone: string | null };
  readonly plan: BoardPlanV1;
  /** The hold record on the parent: it holds the whole batch, or the issues of its `Issues:` line. */
  readonly merge_hold: BoardMergeHoldV1;
  /** The model family of the configured `reviewer` seat (seats config); null when its model names no known family. It decides which acceptance rows are the reviewer's. */
  readonly reviewer_family: string | null;
  readonly items: readonly BoardItemV1[];
  readonly pull_requests: readonly BoardPullRequestV1[];
  readonly path_owners: BoardPathOwnersV1;
  readonly execution: BoardExecutionV1;
  readonly daily_run: BoardDailyRunV1;
  readonly tooling: BoardToolingV1;
}

export type BoardDailyRunInputV1 =
  | { readonly status: 'observed'; readonly run_url: string; readonly conclusion: string | null; readonly created_at: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/** One readiness answer and the time of the read that produced it. */
export interface BoardReadinessV1 {
  readonly readiness: PullRequestReadinessV2;
  readonly observed_at: string;
}

export interface BoardInputV1 {
  readonly observed_at: string;
  readonly parent: BoardParentReadV1;
  readonly acceptance_merge: BoardAcceptanceMergeV1;
  readonly reviewer_family: string | null;
  readonly pull_requests: readonly BoardPullRequestReadV1[];
  readonly readiness: readonly BoardReadinessV1[];
  /** The required contexts of each base ref of the pull requests, by base ref. */
  readonly required_contexts: ReadonlyMap<string, BoardRequiredContextsV1>;
  readonly path_owners: BoardPathOwnersV1;
  readonly execution: BoardExecutionV1;
  readonly daily_run: BoardDailyRunInputV1;
  readonly tooling: BoardToolingV1;
}

const SECOND_REVIEWS: ReadonlySet<unknown> = new Set<BoardSecondReviewV1>(['not_required', 'pending', 'recorded']);

const GATEKEEPER_REVIEWS: ReadonlySet<unknown> = new Set<BoardGatekeeperReviewV1>(['pass', 'fail', 'none', 'unknown']);

const SWITCH_VALUES: ReadonlySet<unknown> = new Set<BoardAcceptanceMergeV1>(['off', 'on', 'unknown']);

/** The `branch` and `status_msg` checks of the board and the parent list decoders: an absent value is a refusal, and null is the explicit none. The error never repeats a refused message. */
export function checkSeatTerminals(terminals: unknown): void {
  if (!Array.isArray(terminals)) throw new Error('board seat terminals are not a list');
  for (const { address, branch, status_msg } of terminals as readonly BoardTerminalV1[]) {
    if (branch !== null && (typeof branch !== 'string' || branch === '')) throw new Error(`invalid board seat branch on ${address}: ${String(branch)}`);
    if (!isSeatStatusMessage(status_msg)) throw new Error(`invalid board seat status message on ${address}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTime = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function isIssueClaim(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'none' || value.status === 'unknown') return true;
  return value.status === 'active' && typeof value.url === 'string' && isTime(value.created_at) && (value.role === null || typeof value.role === 'string');
}

function isReviewRecords(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'unknown') return value.reason === 'comments_truncated' || value.reason === 'acceptance_record_unparsed';
  return value.status === 'observed' && [value.gatekeeper, value.reviewer].every(time => time === null || isTime(time));
}

function isOpenQuestions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'unknown') return true;
  return value.status === 'observed' && Array.isArray(value.questions)
    && value.questions.every((question: unknown) => isRecord(question) && typeof question.url === 'string' && isTime(question.created_at));
}

/** Refuse a board of another protocol or kind, or a board without a valid new value, at a process boundary (Surface contract, docs/adr/ADR-0002). */
export function decodeBoard(value: unknown): BoardV1 {
  const board = value as Partial<BoardV1> | null;
  if (board?.protocol !== BOARD_PROTOCOL) throw new Error(`unsupported board protocol: ${String(board?.protocol)}`);
  if (board.kind !== BOARD_KIND) throw new Error(`unsupported board kind: ${String(board.kind)}`);
  if (!SWITCH_VALUES.has(board.acceptance_merge)) throw new Error(`invalid board acceptance_merge: ${String(board.acceptance_merge)}`);
  if (board.plan?.status === 'observed') {
    const { revision } = board.plan;
    if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error(`invalid board plan revision: ${String(revision)}`);
  }
  if (board.reviewer_family !== null && (typeof board.reviewer_family !== 'string' || board.reviewer_family === '')) throw new Error(`invalid board reviewer_family: ${String(board.reviewer_family)}`);
  if (board.execution?.status === 'observed') checkSeatTerminals(board.execution.terminals);
  for (const item of board.items ?? []) {
    if (!isIssueClaim(item.claim)) throw new Error(`invalid board claim on #${item.number}`);
    if (!isOpenQuestions(item.open_questions)) throw new Error(`invalid board open_questions on #${item.number}`);
  }
  for (const pr of board.pull_requests ?? []) {
    if (!isOpenQuestions(pr.open_questions)) throw new Error(`invalid board open_questions on PR #${pr.number}`);
    const fail: unknown = pr.review_fail;
    if (fail !== null && !(isRecord(fail) && typeof fail.url === 'string' && isTime(fail.recorded_at))) throw new Error(`invalid board review_fail on PR #${pr.number}`);
    if (!SECOND_REVIEWS.has(pr.second_review)) throw new Error(`invalid board second_review on PR #${pr.number}`);
    if (!GATEKEEPER_REVIEWS.has(pr.gatekeeper_review)) throw new Error(`invalid board gatekeeper_review on PR #${pr.number}`);
    if (!isReviewRecords(pr.review_records)) throw new Error(`invalid board review_records on PR #${pr.number}`);
    const observedAt: unknown = pr.merge_readiness_observed_at;
    if (pr.merge_readiness === null ? observedAt !== null : typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw new Error(`invalid board merge_readiness_observed_at on PR #${pr.number}: ${String(observedAt)}`);
    }
  }
  return board as BoardV1;
}

/**
 * The plan of one comment thread, from its newest plan comment: observed with its block, absent, or unavailable with the decode error.
 * The board and `rh board post plan` read it here, so one decoder decides what a plan is.
 */
export function planFromComments(comments: BoardCommentPageV1): BoardPlanV1 {
  const comment = newestProtocolComment(comments, PLAN_HEADER);
  if (comment === null) return { status: 'absent', truncated: comments.truncated };
  try {
    const revision = comments.truncated ? null : protocolComments(comments, PLAN_HEADER).length;
    return { status: 'observed', comment_url: comment.url, created_at: comment.created_at, revision, block: decodePlanBlock(comment.body) };
  } catch (error) {
    if (!(error instanceof PlanBlockError)) throw error;
    return { status: 'unavailable', comment_url: comment.url, reason: error.message };
  }
}

function claimStatus(issue: BoardSubIssueReadV1): BoardClaimStatusV1 {
  const comment = newestProtocolComment(issue.comments, CLAIM_STATUS_HEADER);
  const status = comment === null ? null : parseClaimStatus(comment);
  if (status !== null) return { status_kind: 'observed', ...status };
  return issue.comments.truncated ? { status_kind: 'unknown' } : { status_kind: 'none' };
}

function bodyLinks(repository: string, body: string): { readonly closes: number[]; readonly refs: number[] } {
  const prefix = `${repository.toLowerCase()}#`;
  const closes = parseClosingReferences(repository, body).references
    .filter(reference => reference.startsWith(prefix))
    .map(reference => Number(reference.slice(prefix.length)));
  return { closes, refs: parseRefs(body) };
}

/** A cross-reference alone does not link a pull request to an item; its body must close or ref one. */
export function linkedPullRequests(parent: BoardParentReadV1, reads: readonly BoardPullRequestReadV1[]): BoardPullRequestReadV1[] {
  const items = new Set(parent.sub_issues.map(issue => issue.number));
  return reads.filter((read) => {
    const links = bodyLinks(parent.repository.name_with_owner, read.body);
    return [...links.closes, ...links.refs].some(number => items.has(number));
  });
}

export function projectBoard(input: BoardInputV1): BoardV1 {
  const repository = input.parent.repository.name_with_owner;
  const tiers = new Map(input.parent.sub_issues.map(issue => [issue.number, tierOf(issue.labels)] as const));
  const pullRequests = linkedPullRequests(input.parent, input.pull_requests).map((read): BoardPullRequestV1 => {
    const { closes, refs } = bodyLinks(repository, read.body);
    const required = input.required_contexts.get(read.base_ref);
    if (required === undefined) throw new Error(`board input has no required contexts for base ${read.base_ref} of PR #${read.number}`);
    const check = requiredCheck(read, required);
    const tier = effectiveTier(read, closes, refs, input.parent, tiers);
    const second = secondReview(read, tier, input.reviewer_family);
    const readiness = read.state === 'open' ? input.readiness.find(entry => entry.readiness.pr_number === read.number) : undefined;
    if (read.state === 'open' && readiness === undefined) throw new Error(`board input has no merge readiness for open PR #${read.number}`);
    return Object.freeze({
      number: read.number,
      url: read.url,
      state: read.state,
      is_draft: read.is_draft,
      base_ref: read.base_ref,
      base_sha: read.base_sha,
      head_ref: read.head_ref,
      head_sha: read.head_sha,
      head_committed_at: read.head_committed_at,
      merged_at: read.merged_at,
      closes: Object.freeze(closes),
      refs: Object.freeze(refs),
      files: read.files,
      required_check: check,
      // An issue outside this board has no observed tier, so it withholds the Low path; so does any non-Low linked issue.
      acceptance: acceptance(read, check, [tier], reviewRule(read, tier)),
      review_fail: reviewFail(read),
      review_records: reviewRecords(read, input.reviewer_family),
      open_questions: openQuestions(read.comments),
      merge_readiness: readiness?.readiness ?? null,
      merge_readiness_observed_at: readiness?.observed_at ?? null,
      tier,
      second_review: second,
      gatekeeper_review: gatekeeperReview(read, input.reviewer_family),
      writer_family: writerFamily(read, closes, refs, input.parent),
      merge_hold: readMergeHold(read.comments, false),
    });
  }).sort((left, right) => left.number - right.number);
  if (input.path_owners.status === 'observed') {
    const owned = new Set(input.path_owners.owners.map(owner => owner.path));
    const missing = pullRequests.filter(pr => pr.state === 'open').flatMap(pr => pr.files ?? []).find(path => !owned.has(path));
    if (missing !== undefined) throw new Error(`board input has no path owner for ${missing}`);
  }
  const items = input.parent.sub_issues.map((issue): BoardItemV1 => Object.freeze({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    labels: issue.labels,
    tier: tiers.get(issue.number) ?? null,
    milestone: issue.milestone,
    blocked_by: issue.blocked_by,
    claim: issueClaim(issue.comments),
    claim_status: claimStatus(issue),
    open_questions: openQuestions(issue.comments),
    pull_requests: Object.freeze(pullRequests.filter(pr => pr.closes.includes(issue.number) || pr.refs.includes(issue.number)).map(pr => pr.number)),
    merge_hold: readMergeHold(issue.comments, false),
  })).sort((left, right) => left.number - right.number);
  const daily: BoardDailyRunV1 = input.daily_run.status === 'unavailable' ? input.daily_run : {
    ...input.daily_run,
    open_repair_issues: Object.freeze(input.parent.repair_candidates.filter(issue => isCiRepairIssueBody(issue.body)).map(issue => issue.number).sort((left, right) => left - right)),
  };
  const parent = input.parent.parent;
  return Object.freeze({
    protocol: BOARD_PROTOCOL,
    kind: BOARD_KIND,
    observed_at: input.observed_at,
    repository,
    default_branch: input.parent.repository.default_branch,
    acceptance_merge: input.acceptance_merge,
    parent: Object.freeze({ number: parent.number, title: parent.title, url: parent.url, state: parent.state, labels: parent.labels, milestone: parent.milestone }),
    plan: planFromComments(parent.comments),
    merge_hold: readMergeHold(parent.comments, true),
    reviewer_family: input.reviewer_family,
    items: Object.freeze(items),
    pull_requests: Object.freeze(pullRequests),
    path_owners: input.path_owners,
    execution: input.execution,
    daily_run: daily,
    tooling: input.tooling,
  });
}
