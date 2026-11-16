import { ACCEPTANCE_RECORD_HEADER, type BoardV1 } from './board';
import { planRefusal, requiredCheckDetail } from './merge';
import type { SeatRouteV1 } from './seat-routing';
import { isReviewSeat, SEAT_IDS, type SeatId } from './seats-settings';
import { modelFamily } from '../review/model-family';
import { claimStatusTarget, newestProtocolComment, parseAcceptanceRecord, parseClaimStatus, protocolComments, type BoardCommentPageV1, type BoardCommentV1 } from './source';

/**
 * Review start (#2002): which open pull requests need a review seat now, and which seats. It is a pure projection
 * of the board and of the start markers on each pull request. It writes nothing.
 *
 * A start marker is one `repo-harness review start` comment with `Subject: <head sha>` and `Seat: gatekeeper|reviewer`. It covers
 * that head for that seat until a `repo-harness review start status` comment with `Status: released` names it. The marker is the
 * one record that a seat started for a head, so a second run, or a seat that ended without a record, never starts a second seat
 * of the same role, and a seat that was not sent retries without restarting the other. The reviewer family is the model family of the
 * configured `reviewer` seat (`BoardV1.reviewer_family`); a row belongs to a seat by the family of its model. A High head starts the
 * gatekeeper, and the reviewer too while the board reports `second_review: pending`. A Medium head starts the one seat of the other
 * family than the writer's: the gatekeeper for a writer of the reviewer family, the reviewer for any other known family. An unknown
 * writer family starts no seat, because no seat is sure to record `different-family`. A gatekeeper starts only when the effective
 * gatekeeper (#2253) has a known model family, is not of the writer's family where it gives the different-family row (a Medium head,
 * or a High head that takes no reviewer row), and is not of the reviewer family where the head takes a reviewer row. The reviewer
 * starts only with a known family that differs from the gatekeeper's on a High head: equal families leave the two rows not independent.
 */
export const REVIEW_START_HEADER = 'repo-harness review start';
export const REVIEW_START_STATUS_HEADER = 'repo-harness review start status';

export type ReviewSkipReason = 'not_open' | 'draft' | 'ci_not_green' | 'accepted' | 'acceptance_unknown' | 'started' | 'writer_family_unknown' | 'review_family_unavailable' | 'plan_hold' | 'plan_unavailable';

export type ReviewSeat = 'gatekeeper' | 'reviewer';

export interface ReviewSeatStartV1 {
  readonly seat: ReviewSeat;
  /** The earlier head that this seat's own review finished; null gives the seat the whole diff. */
  readonly delta_from: string | null;
}

export type ReviewDecisionV1 =
  | { readonly pr: number; readonly action: 'start'; readonly head_ref: string; readonly head_sha: string; readonly tier: 'medium' | 'high'; readonly round: number; readonly seats: readonly ReviewSeatStartV1[] }
  | { readonly pr: number; readonly action: 'skip'; readonly reason: ReviewSkipReason; readonly detail: string };

export interface ReviewInputV1 {
  readonly board: BoardV1;
  /** The comments of each open pull request of the board. */
  readonly comments: ReadonlyMap<number, BoardCommentPageV1>;
  /** `effectiveGatekeeper`: the seat that `seats argv gatekeeper` launches now, and its route line. */
  readonly gatekeeper: SeatRouteV1;
}

/** Why the effective gatekeeper cannot give this head its different-family review, or null when it can. */
function gatekeeperFamilyGap(gatekeeper: SeatRouteV1, writer: string | null, givesDifferentFamily: boolean, reviewer: string | null): string | null {
  const family = gatekeeperFamily(gatekeeper);
  if (gatekeeper.id === null) return 'no gatekeeper seat can launch';
  if (family === null) return `the model ${gatekeeper.seat.model ?? 'default'} has no known family`;
  if (givesDifferentFamily && family === writer) return `the gatekeeper family ${family} is the writer family`;
  return reviewer !== null && family === reviewer ? `this head takes a reviewer row, so the gatekeeper family ${family} must differ from the reviewer family` : null;
}

const gatekeeperFamily = (gatekeeper: SeatRouteV1): string | null => gatekeeper.id === null || gatekeeper.seat.model === null ? null : modelFamily(gatekeeper.seat.model);

/** Why the configured reviewer cannot give this head an independent row, or null when it can. */
function reviewerFamilyGap(reviewer: string | null, gatekeepers: readonly (string | null)[], tier: 'medium' | 'high'): string | null {
  if (reviewer === null) return 'the reviewer seat model has no known family';
  return tier === 'high' && gatekeepers.includes(reviewer) ? `the reviewer family ${reviewer} is the gatekeeper family, so the two rows are not independent` : null;
}

const field = (comment: BoardCommentV1, name: string): string | null => {
  const line = comment.body.replace(/\r\n/gu, '\n').split('\n').find(entry => entry.startsWith(`${name}: `));
  return line === undefined ? null : line.slice(name.length + 2).trim();
};

/** The live markers of one seat: those that no `released` status names. */
function liveMarkers(page: BoardCommentPageV1, seat: ReviewSeat): BoardCommentV1[] {
  const released = new Set(protocolComments(page, REVIEW_START_STATUS_HEADER)
    .filter(comment => parseClaimStatus(comment)?.status.startsWith('released') === true)
    .map(claimStatusTarget));
  return protocolComments(page, REVIEW_START_HEADER).filter(comment => field(comment, 'Seat') === seat && !released.has(comment.url));
}

/** The model families of the acceptance rows that already name this head. */
function recordedFamilies(page: BoardCommentPageV1, head: string): string[] {
  return protocolComments(page, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? [])
    .filter(row => row.subject_sha === head && row.model !== null).flatMap(row => modelFamily(row.model!) ?? []);
}

/**
 * The newest earlier head that a live marker of this seat started and that has an acceptance row of this seat's model family:
 * the reviewer family for the reviewer, any other known family for the gatekeeper. A start without such a row gives no base, so that
 * seat reviews the whole diff, whatever the other seat finished.
 */
function deltaBase(page: BoardCommentPageV1, head: string, seat: ReviewSeat, reviewer: string | null): string | null {
  const own = (model: string | null): boolean => {
    const family = model === null ? null : modelFamily(model);
    return family !== null && (seat === 'reviewer' ? family === reviewer : family !== reviewer);
  };
  const recorded = new Set(protocolComments(page, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? []).filter(row => own(row.model)).map(row => row.subject_sha));
  const earlier = liveMarkers(page, seat).filter(marker => field(marker, 'Subject') !== head && recorded.has(field(marker, 'Subject') ?? ''));
  const newest = earlier.length === 0 ? null : newestProtocolComment({ ...page, comments: earlier }, REVIEW_START_HEADER);
  return newest === null ? null : field(newest, 'Subject');
}

/**
 * The round of a head: the round of an acceptance row or claim that already names it (a High head has two reviews of one round),
 * else one past the newest round of any of them. A claim counts too, so a publish that stopped after its claim keeps its round.
 */
function roundOf(page: BoardCommentPageV1, head: string): number {
  const rows = [
    ...protocolComments(page, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? []).map(row => ({ round: row.round, subject: row.subject_sha })),
    ...protocolComments(page, 'repo-harness acceptance claim').map(claim => ({ round: Number(field(claim, 'Round')), subject: field(claim, 'Subject') })).filter(row => Number.isSafeInteger(row.round) && row.round > 0),
  ];
  return rows.find(row => row.subject === head)?.round ?? Math.max(0, ...rows.map(row => row.round)) + 1;
}

export interface ReviewPacketBinding { readonly pr: number; readonly head_sha: string; readonly seat: SeatId }

/** The packet's first sentence: the one text that binds a seat session to its PR, head and seat. `parseReviewPacket` reads it back. */
const PACKET_HEAD = /Task: review PR #([1-9][0-9]*) at head ([0-9a-f]{40}|[0-9a-f]{64}) \(tier (?:medium|high), round [1-9][0-9]*\), as the ([a-z]+(?:-[a-z]+)*) of repo-harness-issue-flow\./u;

export function parseReviewPacket(text: string): ReviewPacketBinding | null {
  const match = PACKET_HEAD.exec(text);
  const seat = SEAT_IDS.find(id => id === match?.[3]);
  return match === null || seat === undefined || !isReviewSeat(seat) ? null : { pr: Number(match[1]), head_sha: match[2]!, seat };
}

/**
 * The task text of a review seat. It states each value of the receipt that the seat cannot know, and the hand-off: a read-only seat
 * cannot write a file or publish, so it ends its reply with the receipt and the orchestrator publishes it with `rh review collect`.
 */
export function reviewPacket(decision: Extract<ReviewDecisionV1, { action: 'start' }>, start: ReviewSeatStartV1, harness: 'claude' | 'codex' | 'pi'): string {
  const scope = start.delta_from === null
    ? 'Review the whole diff.'
    : `This is a delta review. Review the hunks that changed since ${start.delta_from} and the sibling cases of each earlier finding.`;
  return `Task: review PR #${decision.pr} at head ${decision.head_sha} (tier ${decision.tier}, round ${decision.round}), as the ${start.seat} of repo-harness-issue-flow. The worktree is at that head. ${scope} Read the PR body, the issue and the recorded evidence first: gh pr view ${decision.pr} --comments. You are read-only. Receipt values (repo-harness-review-publish-receipt protocol 2): round ${decision.round}, risk_tier "${decision.tier}", subject_sha ${decision.head_sha}, reviewer.harness "${harness}" (exactly this value); confirmed_fixed lists the node ids of the earlier-round review publish threads whose fix you confirmed at this head, or []. Do not publish. End your last reply with the line RECEIPT-JSON and then the receipt as one JSON object; the orchestrator publishes it with rh review collect.`;
}

export function planReview(input: ReviewInputV1): readonly ReviewDecisionV1[] {
  const { board } = input;
  return board.pull_requests.map((pr): ReviewDecisionV1 => {
    const skip = (reason: ReviewSkipReason, detail: string): ReviewDecisionV1 => ({ pr: pr.number, action: 'skip', reason, detail });
    if (pr.state !== 'open') return skip('not_open', `the pull request is ${pr.state}`);
    if (pr.is_draft) return skip('draft', 'the pull request is a draft');
    const refused = planRefusal(board, pr);
    if (refused !== null) return skip(refused.reason, refused.detail);
    if (pr.required_check.status !== 'success') return skip('ci_not_green', requiredCheckDetail(pr.required_check));
    if (pr.acceptance.status === 'accepted') return skip('accepted', `an acceptance covers ${pr.head_sha}`);
    if (pr.acceptance.status === 'unknown') return skip('acceptance_unknown', pr.acceptance.reason);
    // An unknown tier is High: a pull request that no tier label covers still gets a review.
    const tier = pr.tier ?? 'high';
    if (tier === 'low') return skip('accepted', 'a Low pull request takes no review seat');
    if (tier === 'medium' && pr.writer_family === null) return skip('writer_family_unknown', 'no writer claim of the head branch has a Model line with a known family, so no seat is sure to be the other family');
    const page = input.comments.get(pr.number);
    if (page === undefined) return skip('started', 'the comments of the pull request were not read');
    if (page.truncated) return skip('started', 'older comments were not read, so a start marker cannot be ruled out');
    const reviewer = board.reviewer_family;
    const required: readonly ReviewSeat[] = tier === 'medium' ? [reviewer !== null && pr.writer_family === reviewer ? 'gatekeeper' : 'reviewer']
      : pr.second_review === 'pending' ? ['gatekeeper', 'reviewer'] : ['gatekeeper'];
    const seats = required.filter(seat => !liveMarkers(page, seat).some(marker => field(marker, 'Subject') === pr.head_sha))
      .map((seat): ReviewSeatStartV1 => ({ seat, delta_from: deltaBase(page, pr.head_sha, seat, reviewer) }));
    if (seats.length === 0) return skip('started', `a start marker of every required seat covers ${pr.head_sha}`);
    // A High head that takes a reviewer row needs a gatekeeper of another family than the reviewer's, or the two rows are one family.
    const reviewerRow = tier === 'high' && pr.second_review !== 'not_required';
    // Where the reviewer takes part in a High head, it can give the different-family row, so the gatekeeper may share the writer family.
    const givesDifferentFamily = tier === 'medium' || pr.second_review === 'not_required';
    const gatekeeperGap = seats.some(entry => entry.seat === 'gatekeeper') ? gatekeeperFamilyGap(input.gatekeeper, pr.writer_family, givesDifferentFamily, reviewerRow ? reviewer : null) : null;
    if (gatekeeperGap !== null) return skip('review_family_unavailable', `${gatekeeperGap}; ${input.gatekeeper.line}`);
    // A gatekeeper that already started for this head is the one that counts: its recorded rows give its family, and only a head with no row yet falls back to the current route.
    const startedFamilies = seats.some(entry => entry.seat === 'gatekeeper') ? [] : recordedFamilies(page, pr.head_sha);
    const reviewerGap = seats.some(entry => entry.seat === 'reviewer')
      ? reviewerFamilyGap(reviewer, startedFamilies.length > 0 ? startedFamilies : [gatekeeperFamily(input.gatekeeper)], tier) : null;
    if (reviewerGap !== null) return skip('review_family_unavailable', reviewerGap);
    return { pr: pr.number, action: 'start', head_ref: pr.head_ref, head_sha: pr.head_sha, tier, round: roundOf(page, pr.head_sha), seats };
  });
}
