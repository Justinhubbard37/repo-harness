import { lstatSync, readFileSync } from 'fs';
import {
  renderConfirmedReply,
  renderAcceptanceClaim,
  renderAcceptanceRecord,
  validateReviewPublishReceipt,
  type ReviewDiffLines,
  type ReviewPublishReceipt,
} from '../../core/review/review-publish';
import { errorMessage } from '../../core/evidence/error-message';
import {
  ReviewPublishError,
  createGhRunner,
  GhMutationUnknownError,
  ghJson,
  prHead,
  prDiffLines,
  existingClaimUrl,
  postComment,
  postReview,
  field,
  checkConfirmedThreads,
  checkOwnerRecord,
  type ReviewPublishGhRunner,
  type PullRequestHead,
} from './review-publish-gh';

export {
  ReviewPublishError,
  type ReviewPublishErrorCode,
  type ReviewPublishGhResult,
  type ReviewPublishGhRunner,
} from './review-publish-gh';

export interface ReviewPublishResult {
  readonly ok: true;
  readonly pr: number;
  readonly head_sha: string;
  readonly round: number;
  readonly claim_url: string;
  readonly review_url: string;
  readonly record_url: string;
  readonly threads: number;
  /** Node ids of the earlier-round threads that publish replied on and resolved. */
  readonly resolved_threads: readonly string[];
  /** Confirmed node ids that were already resolved; publish left them unchanged. */
  readonly already_resolved_threads: readonly string[];
}

export interface ReviewPublishInput {
  readonly repoRoot: string;
  readonly prNumber: number;
  /** Rule 1 stops a review at round 5; a later round needs this owner decision comment. */
  readonly ownerRecord?: string;
  readonly ghBin?: string;
  /** Test seam. Production runs the configured gh binary. */
  readonly ghRunner?: ReviewPublishGhRunner;
}

const MAX_RECEIPT_BYTES = 1024 * 1024;
const REPLY_MUTATION = 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { url } } }';
const RESOLVE_MUTATION = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';

function readReceipt(path: string): ReviewPublishReceipt {
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
      throw new Error('receipt must be a regular file of at most 1 MiB');
    }
    bytes = readFileSync(path);
  } catch (error) {
    throw new ReviewPublishError('review_receipt_invalid', 'review receipt is unreadable: ' + errorMessage(error), 2);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ReviewPublishError('review_receipt_invalid', 'review receipt is not valid JSON: ' + errorMessage(error), 2);
  }
  return parseReceipt(value);
}

/** The one receipt validator; `review publish` and `review collect` both end here. */
export function parseReceipt(value: unknown): ReviewPublishReceipt {
  try {
    return validateReviewPublishReceipt(value);
  } catch (error) {
    throw new ReviewPublishError('review_receipt_invalid', errorMessage(error), 2);
  }
}

function partial(message: string, posted: readonly string[], cause?: unknown): ReviewPublishError {
  return new ReviewPublishError('review_publish_partial', message, 5, [...posted], cause === undefined ? undefined : { cause: errorMessage(cause) });
}

/** A POST may have reached GitHub; never retry without inspecting the PR first. */
function unknownOutcome(message: string, posted: readonly string[], cause?: unknown): ReviewPublishError {
  return new ReviewPublishError('review_publish_unknown', message, 5, [...posted], {
    inspect_required: true,
    ...(cause === undefined ? {} : { cause: errorMessage(cause) }),
  });
}

/** The head SHA of the PR now, read through the same gh runner and checks as `publishReceipt`. */
export function readPrHeadSha(input: ReviewPublishInput): string {
  try {
    return prHead(input.ghRunner ?? createGhRunner(input.repoRoot, input.ghBin), input.prNumber).headSha.toLowerCase();
  } catch (error) {
    throw new ReviewPublishError('review_publish_provider_unavailable', errorMessage(error), 1);
  }
}

export function publishReview(input: ReviewPublishInput & { readonly receiptPath: string }): ReviewPublishResult {
  return publishReceipt(input, readReceipt(input.receiptPath));
}

export function publishReceipt(input: ReviewPublishInput, receipt: ReviewPublishReceipt): ReviewPublishResult {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    throw new ReviewPublishError('review_receipt_invalid', 'review publish requires a positive PR number', 2);
  }
  const run = input.ghRunner ?? createGhRunner(input.repoRoot, input.ghBin);
  let pr: PullRequestHead;
  try {
    pr = prHead(run, input.prNumber);
  } catch (error) {
    throw new ReviewPublishError('review_publish_provider_unavailable', errorMessage(error), 1);
  }
  if (receipt.subject_sha !== pr.headSha.toLowerCase()) {
    throw new ReviewPublishError('review_subject_stale',
      'review receipt subject ' + receipt.subject_sha + ' is not the PR head ' + pr.headSha + '; nothing was posted', 2);
  }
  checkOwnerRecord(input.ownerRecord, receipt.round, pr, input.prNumber);
  const claimBody = renderAcceptanceClaim(receipt, input.ownerRecord);
  let diffLines: ReviewDiffLines;
  let existingClaim: string | null;
  let alreadyResolved: ReadonlySet<string>;
  try {
    diffLines = prDiffLines(run, pr.slug, input.prNumber);
    existingClaim = existingClaimUrl(run, pr.slug, input.prNumber, receipt, claimBody);
    alreadyResolved = checkConfirmedThreads(run, pr.slug, input.prNumber, receipt);
  } catch (error) {
    if (error instanceof ReviewPublishError) throw error;
    throw new ReviewPublishError('review_publish_provider_unavailable', 'nothing was posted: ' + errorMessage(error), 1);
  }
  const posted: string[] = [];
  const confirmHead = (stage: string, progress = ''): void => {
    let current: PullRequestHead;
    try {
      current = prHead(run, input.prNumber);
    } catch (error) {
      throw partial('the PR head could not be re-read before the ' + stage + progress + '; inspection is required: ' + errorMessage(error), posted, error);
    }
    if (current.slug !== pr.slug || current.headSha.toLowerCase() !== receipt.subject_sha) {
      throw partial('the PR head moved from ' + pr.headSha + ' to ' + current.headSha + ' before the ' + stage
        + '; receipt subject ' + receipt.subject_sha + ' was not published to the ' + stage + progress + '; inspection is required', posted);
    }
  };
  let claimUrl: string;
  try {
    claimUrl = existingClaim ?? postComment(run, pr.slug, input.prNumber, claimBody);
  } catch (error) {
    if (error instanceof GhMutationUnknownError) {
      if (error.confirmedUrl !== undefined) posted.push(error.confirmedUrl);
      throw unknownOutcome('the acceptance claim POST outcome is unknown; inspection is required before any retry: ' + errorMessage(error), posted, error);
    }
    throw new ReviewPublishError('review_publish_failed', 'acceptance claim was not posted: ' + errorMessage(error), 1, posted);
  }
  posted.push(claimUrl);
  confirmHead('review');
  let reviewUrl: string;
  let threads: number;
  try {
    ({ url: reviewUrl, threads } = postReview(run, pr.slug, input.prNumber, pr.headSha, receipt, diffLines));
  } catch (error) {
    if (error instanceof GhMutationUnknownError) {
      if (error.confirmedUrl !== undefined && !posted.includes(error.confirmedUrl)) posted.push(error.confirmedUrl);
      throw unknownOutcome('the acceptance review POST outcome is unknown; inspection is required before any retry: ' + errorMessage(error), posted, error);
    }
    throw partial('acceptance review was not posted after the claim: ' + errorMessage(error), posted, error);
  }
  posted.push(reviewUrl);
  confirmHead('record');
  let recordUrl: string;
  try {
    recordUrl = postComment(run, pr.slug, input.prNumber, renderAcceptanceRecord(receipt, claimUrl, input.ownerRecord));
  } catch (error) {
    if (error instanceof GhMutationUnknownError) {
      if (error.confirmedUrl !== undefined) posted.push(error.confirmedUrl);
      throw unknownOutcome('the acceptance record POST outcome is unknown; inspection is required before any retry: ' + errorMessage(error), posted, error);
    }
    throw partial('acceptance record was not posted after the review: ' + errorMessage(error), posted, error);
  }
  posted.push(recordUrl);
  const reply = renderConfirmedReply(receipt, recordUrl);
  const pending = receipt.confirmed_fixed.filter((id) => !alreadyResolved.has(id));
  const resolved: string[] = [];
  for (const id of pending) {
    // Only the mutation payload confirms a thread write; any other answer may
    // follow an accepted write, so it is an unknown outcome.
    for (const [stage, args, confirmed] of [
      ['reply', ['-f', 'query=' + REPLY_MUTATION, '-f', 'id=' + id, '-f', 'body=' + reply],
        (data: unknown) => { const url = field(field(field(data, 'addPullRequestReviewThreadReply'), 'comment'), 'url'); return typeof url === 'string' && url !== ''; }],
      ['resolve', ['-f', 'query=' + RESOLVE_MUTATION, '-f', 'id=' + id],
        (data: unknown) => field(field(field(data, 'resolveReviewThread'), 'thread'), 'isResolved') === true],
    ] as const) {
      const done = 'record ' + recordUrl + '; resolved threads: ' + (resolved.join(', ') || 'none')
        + '; unresolved threads: ' + pending.slice(resolved.length).join(', ');
      confirmHead(stage + ' on thread ' + id, '; ' + done);
      try {
        const response = ghJson(run, ['api', 'graphql', '--hostname', 'github.com', ...args], undefined, { mutation: true });
        if (!confirmed(response.data)) throw new GhMutationUnknownError('the ' + stage + ' response does not confirm the write');
      } catch (error) {
        if (error instanceof GhMutationUnknownError) throw unknownOutcome('the ' + stage + ' outcome on thread ' + id + ' is unknown; ' + done + '; inspection is required before any retry: ' + errorMessage(error), posted, error);
        throw partial('the ' + stage + ' on thread ' + id + ' failed after the record; ' + done + ': ' + errorMessage(error), posted, error);
      }
    }
    resolved.push(id);
  }
  return Object.freeze({
    ok: true as const,
    pr: input.prNumber,
    head_sha: pr.headSha,
    round: receipt.round,
    claim_url: claimUrl,
    review_url: reviewUrl,
    record_url: recordUrl,
    threads,
    resolved_threads: Object.freeze(resolved),
    already_resolved_threads: Object.freeze(receipt.confirmed_fixed.filter((id) => alreadyResolved.has(id))),
  });
}
