/** Manual GitHub feedback observation and durable intake. */
import { gitSpawnSync } from '../git/runner';

import { buildFeedbackDeliveryReceipt, deriveFeedbackRevision, deriveReactionToken, projectRepairOffer, transitionFeedbackDeliveryReceipt, type FeedbackDeliveryTransitionInput, type FeedbackEventV1, type FeedbackFailingCheckV1, type FeedbackMergeability, type RepairOfferProjection } from '../../core/publication/feedback';
import { byteCompare } from '../../core/evidence/byte-compare';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withTaskLock } from '../locking/task-lock';
import { FeedbackStoreError, readFeedbackDeliveryReceipt, readFeedbackDeliveryReceipts, readFeedbackEvent, readFeedbackEvents, readReactionAttemptReceipts, writeFeedbackDeliveryReceipt, writeFeedbackEvent } from '../publication/feedback-store';
import { publicationSha256, stablePublicationJson } from '../../core/publication/publication-receipt';
import { validatePullRequestSelection } from '../publication/merge-readiness';
import type { PullRequestSelectionV2 } from '../../core/publication/merge-readiness';
import { observeTaskInboxContext, type TaskInboxSessionSource } from './task-inbox';
import { readTaskAgent } from '../terminal/task-session-record';
import { observeActiveReviewAdmission } from '../admission/issue-goal';
import { readActiveReviewAdmission } from '../admission/admission-store';
import {
  FeedbackError,
  TornReadError,
  assertStableIdentity,
  checkRunBody,
  observeGitHubFeedback,
  observeIdentity,
  reviewBody,
  reviewThreadBody,
  type FeedbackObservationInput,
  type FeedbackSubject,
} from './provider-feedback-github';

export { FeedbackError, observeGitHubFeedback } from './provider-feedback-github';
export type { FeedbackErrorCode, FeedbackObservationInput, FeedbackSubject, GhRunResult } from './provider-feedback-github';

export interface FeedbackIntakeInput extends FeedbackObservationInput {
  readonly publication_id: string;
  readonly selection: PullRequestSelectionV2;
  readonly source: TaskInboxSessionSource;
  readonly git_bin?: string;
}

export interface FeedbackIntakeResult {
  readonly publication_id: string;
  readonly event_count: number;
  readonly events: readonly FeedbackEventV1[];
}

export type PendingFeedbackOffer =
  | { readonly state: 'none'; readonly publication_id: string }
  | RepairOfferProjection;

export interface FleetFeedbackProjectionDependencies {
  readonly read_events: typeof readFeedbackEvents;
  readonly read_deliveries: typeof readFeedbackDeliveryReceipts;
  readonly read_reactions: typeof readReactionAttemptReceipts;
}

interface CurrentPublicationSnapshot {
  readonly receipt: FeedbackSubject;
  readonly session_bytes: string;
  readonly assertCurrent: () => void;
}

export interface ShowGitHubFeedbackInput extends FeedbackIntakeInput {
  readonly provider_event_id: string;
  readonly git_bin?: string;
}

export interface ShowGitHubFeedbackResult {
  readonly provider_event_id: string;
  readonly provider_url: string;
  readonly body: string;
  readonly untrusted: true;
}

/**
 * Fetch a full provider body only when an operator explicitly asks for it.
 * The stored event is used solely to identify the immutable provider object;
 * returned text is untrusted display data and is never written back to any
 * feedback, delivery, reaction, or session surface.
 */
export function showGitHubFeedback(input: ShowGitHubFeedbackInput): ShowGitHubFeedbackResult {
  const gitBin = input.git_bin ?? 'git';
  const before = currentPublication(input);
  let event: FeedbackEventV1 | null;
  try {
    event = readFeedbackEvent(input.repo_root, before.receipt.publication_id, input.provider_event_id, gitBin);
  } catch (error) {
    mapStoreError(error);
  }
  if (event === null) throw new FeedbackError('feedback_unreadable', 'provider feedback event is unavailable');
  if (event.publication_id !== before.receipt.publication_id || event.head_sha !== before.receipt.head_sha) {
    throw new FeedbackError('head_moved', 'provider feedback event does not match the current publication head');
  }
  const isCheck = event.failing_checks.length === 1 && event.failing_checks[0]?.id === event.provider_event_id
    && event.failing_check_ids.length === 1 && event.failing_check_ids[0] === event.provider_event_id
    && event.unresolved_review_thread_ids.length === 0 && event.changes_requested_review_ids.length === 0;
  const isThread = event.failing_checks.length === 0 && event.failing_check_ids.length === 0
    && event.unresolved_review_thread_ids.length === 1 && event.unresolved_review_thread_ids[0] === event.provider_event_id
    && event.changes_requested_review_ids.length === 0;
  const isReview = event.failing_checks.length === 0 && event.failing_check_ids.length === 0
    && event.unresolved_review_thread_ids.length === 0
    && event.changes_requested_review_ids.length === 1
    && event.changes_requested_review_ids[0] === event.provider_event_id;
  if ([isCheck, isThread, isReview].filter(Boolean).length !== 1) {
    throw new FeedbackError('feedback_unreadable', 'provider feedback event cannot be mapped to one provider object type');
  }
  let body: string;
  try {
    body = isCheck
      ? checkRunBody(input, event.provider_event_id)
      : isThread
        ? reviewThreadBody(input, event.provider_event_id)
        : reviewBody(input, event.provider_event_id);
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    throw new FeedbackError('feedback_provider_incomplete', 'cannot fetch the requested provider feedback body', error);
  }
  const after = currentPublication(input);
  if (stablePublicationJson(before.receipt) !== stablePublicationJson(after.receipt)
    || before.session_bytes !== after.session_bytes) {
    throw new FeedbackError('feedback_provider_incomplete', 'publication changed during provider feedback display observation');
  }
  return Object.freeze({
    provider_event_id: event.provider_event_id,
    provider_url: event.provider_url,
    body,
    untrusted: true as const,
  });
}

/** Read-only request preparation. References bind already-authorized inputs; they do not authenticate an actor. */
export function prepareFeedbackSubject(input: Omit<FeedbackIntakeInput, 'publication_id'>): FeedbackSubject {
  const selection = validatePullRequestSelection(input.selection);
  const session = observeTaskInboxContext({ repo_root: input.repo_root, source: input.source, task_id: input.source.session.task });
  if (selection.provider_repository_id !== session.identity.repository_id) throw new FeedbackError('publication_claim_mismatch', 'selected PR repository differs from admitted issue repository');
  const basis = { protocol: 2, kind: 'repo-harness-admitted-feedback-subject', selection,
    task_id: session.identity.task, repository_id: session.identity.repository_id, issue_id: session.identity.issue_id,
    campaign_id: session.identity.campaign_id, claim: session.identity.claim,
    admission_sha256: session.approval.admission_sha256 };
  return Object.freeze({ publication_id: publicationSha256(stablePublicationJson(basis)), selection,
    task_id: basis.task_id, repository_id: basis.repository_id, issue_id: basis.issue_id, campaign_id: basis.campaign_id,
    claim: basis.claim, admission_sha256: basis.admission_sha256,
    head_sha: selection.expected_head_sha, base_sha: selection.expected_base_sha, pr_number: selection.pr_number });
}

function executionHead(input: FeedbackIntakeInput, executionRoot: string): string | null {
  const head = gitSpawnSync(['rev-parse', 'HEAD'], { cwd: executionRoot, encoding: 'utf8', gitBin: input.git_bin });
  return head.status === 0 ? head.stdout.trim() : null;
}

/**
 * Only intake binds the local execution HEAD: it records provider feedback as
 * feedback on the commit the admitted session is executing. Show, ack and
 * offer projection read events already bound to the PR head, so a local fix
 * commit made before push must not block them.
 */
function currentPublication(input: FeedbackIntakeInput, bindExecutionHead = false): CurrentPublicationSnapshot {
  const receipt = prepareFeedbackSubject(input);
  if (receipt.publication_id !== input.publication_id) throw new FeedbackError('publication_claim_mismatch', 'feedback subject differs from the explicit current admission and PR selection');
  const binding = readTaskAgent(input.repo_root, input.source.session.task, input.source.session.role);
  if (bindExecutionHead && executionHead(input, binding.binding.execution_root) !== receipt.head_sha) {
    throw new FeedbackError('head_moved', 'feedback intake requires the execution HEAD to equal the selected PR head; push local commits and select the new PR head');
  }
  assertStableIdentity(observeIdentity(receipt, input), receipt);
  const active = observeActiveReviewAdmission(input.source.authority.source);
  if (active.admission.admission_sha256 !== receipt.admission_sha256) throw new TornReadError('admission changed during feedback observation');
  const sessionBytes = stablePublicationJson({ binding: binding.binding, grant_sha256: active.grant_sha256 });
  const assertCurrent = () => {
    const current = readActiveReviewAdmission({ ...input.source.authority.source, expectedGoal: active.admission.goal });
    const latest = readTaskAgent(input.repo_root, input.source.session.task, input.source.session.role);
    if (bindExecutionHead && executionHead(input, latest.binding.execution_root) !== receipt.head_sha) throw new TornReadError('execution HEAD changed during feedback intake');
    if (current.grant_sha256 !== active.grant_sha256 || current.admission.admission_sha256 !== receipt.admission_sha256
      || existsSync(join(latest.dir, 'closed.json')) || stablePublicationJson({ binding: latest.binding, grant_sha256: current.grant_sha256 }) !== sessionBytes) throw new TornReadError('admitted feedback session changed');
  };
  assertCurrent();
  return { receipt, session_bytes: sessionBytes, assertCurrent };
}

function mapStoreError(error: unknown): never {
  if (error instanceof FeedbackError) throw error;
  if (error instanceof FeedbackStoreError) {
    throw new FeedbackError(error.code, error.message, error);
  }
  throw new FeedbackError('feedback_incomplete', 'feedback persistence failed', error);
}

function persistObservedEvents(input: FeedbackIntakeInput, snapshot: CurrentPublicationSnapshot, events: readonly FeedbackEventV1[]): FeedbackIntakeResult {
  try {
    for (const event of events) {
      writeFeedbackEvent(input.repo_root, event, input.git_bin ?? 'git');
      try {
        const delivery = buildFeedbackDeliveryReceipt({
          provider_event_id: event.provider_event_id,
          delivery_state: 'pending',
          delivery_channel: 'none',
          delivered_at: null,
          acknowledged_at: null,
          superseded_at: null,
        });
        // An existing delivery record is mutable notification evidence.  Initial
        // intake only creates pending state and never downgrades an acknowledgement.
        if (readFeedbackDeliveryReceipt(input.repo_root, snapshot.receipt.publication_id, event.provider_event_id, input.git_bin ?? 'git') === null) {
          writeFeedbackDeliveryReceipt(input.repo_root, snapshot.receipt.publication_id, delivery, input.git_bin ?? 'git');
        }
      } catch (error) {
        // The event is already durable.  A retry must repair its missing
        // delivery record, but the caller must be told that this intake was
        // only partially persisted rather than treating it as a clean success.
        throw new FeedbackError('feedback_incomplete', `feedback event ${event.provider_event_id} persisted without a delivery receipt`, error);
      }
    }
  } catch (error) {
    mapStoreError(error);
  }
  return Object.freeze({ publication_id: snapshot.receipt.publication_id, event_count: events.length, events: Object.freeze([...events]) });
}

/**
 * Intake is intentionally the only observer write path. It fences local
 * admitted session state before and after provider observation,
 * retries exactly once for either local or provider torn reads, and never
 * mutates session admission.
 */
export function intakeGitHubFeedback(input: FeedbackIntakeInput): FeedbackIntakeResult {
  let lastTorn: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: CurrentPublicationSnapshot;
    let events: readonly FeedbackEventV1[];
    try {
      before = currentPublication(input, true);
      events = observeGitHubFeedback(before.receipt, input);
    } catch (error) {
      if (error instanceof TornReadError) {
        lastTorn = error;
        continue;
      }
      if (error instanceof FeedbackError) throw error;
      throw new FeedbackError('feedback_incomplete', 'feedback observation failed', error);
    }
    try {
      const result = withTaskLock(input.repo_root, before.receipt.task_id, () => {
        before.assertCurrent();
        const persisted = persistObservedEvents(input, before, events);
        before.assertCurrent();
        return persisted;
      });
      return result;
    } catch (error) {
      if (error instanceof TornReadError) { lastTorn = error; continue; }
      if (error instanceof FeedbackError) throw error;
      throw new FeedbackError('feedback_incomplete', 'feedback intake failed', error);
    }
  }
  throw new FeedbackError('feedback_provider_incomplete', 'provider or local publication changed during both feedback observations', lastTorn);
}

/**
 * Project a repair offer entirely from durable feedback facts. This path reads
 * current admission and writes neither deliveries nor reactions.
 */
export function projectPendingFeedbackOffer(
  input: FeedbackIntakeInput,
): PendingFeedbackOffer {
  const gitBin = input.git_bin ?? 'git';
  let lastTorn: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return observeFeedbackProjection(input, gitBin, productionFleetFeedbackProjectionDependencies);
    } catch (error) {
      if (error instanceof TornReadError) {
        lastTorn = error;
        continue;
      }
      if (error instanceof FeedbackError) throw error;
      if (error instanceof FeedbackStoreError) throw new FeedbackError(error.code, error.message, error);
      throw new FeedbackError('feedback_incomplete', 'feedback offer projection failed', error);
    }
  }
  throw new FeedbackError('feedback_incomplete', 'publication changed during both feedback offer projections', lastTorn);
}

const productionFleetFeedbackProjectionDependencies: FleetFeedbackProjectionDependencies = Object.freeze({
  read_events: readFeedbackEvents,
  read_deliveries: readFeedbackDeliveryReceipts,
  read_reactions: readReactionAttemptReceipts,
});

function observeFeedbackProjection(
  input: FeedbackIntakeInput,
  gitBin: string,
  dependencies: FleetFeedbackProjectionDependencies,
): PendingFeedbackOffer {
  const before = currentPublication(input);
  const publicationId = before.receipt.publication_id;
  const events = dependencies.read_events(input.repo_root, publicationId, gitBin);
  const deliveries = dependencies.read_deliveries(input.repo_root, publicationId, gitBin);
  const reactions = dependencies.read_reactions(input.repo_root, publicationId, gitBin);
  const after = currentPublication(input);
  if (stablePublicationJson(before.receipt) !== stablePublicationJson(after.receipt)
    || before.session_bytes !== after.session_bytes) {
    throw new TornReadError('current publication changed during feedback projection');
  }

  const eventIds = new Set<string>();
  for (const event of events) {
    if (event.publication_id !== publicationId || event.head_sha !== before.receipt.head_sha) {
      throw new FeedbackError('feedback_unreadable', 'feedback event does not match the current publication head');
    }
    eventIds.add(event.provider_event_id);
  }
  const deliveryIds = new Set<string>();
  for (const delivery of deliveries) {
    if (!eventIds.has(delivery.provider_event_id)) {
      throw new FeedbackError('feedback_unreadable', 'feedback delivery receipt has no immutable event');
    }
    deliveryIds.add(delivery.provider_event_id);
  }
  for (const event of events) {
    if (!deliveryIds.has(event.provider_event_id)) {
      throw new FeedbackError('feedback_incomplete', `feedback event ${event.provider_event_id} has no delivery receipt`);
    }
  }

  const feedbackRevision = deriveFeedbackRevision(events);
  let projection: PendingFeedbackOffer;
  if (events.length === 0) {
    projection = Object.freeze({ state: 'none', publication_id: publicationId });
  } else {
    const actionable = actionableFeedbackFacts(events);
    projection = projectRepairOffer({
      task_id: before.receipt.task_id,
      publication_id: publicationId,
      expected_claim: before.receipt.claim,
      admission_sha256: before.receipt.admission_sha256,
      expected_head_sha: before.receipt.head_sha,
      feedback_revision: feedbackRevision,
      reaction_token: deriveReactionToken({
        publication_id: publicationId,
        head_sha: before.receipt.head_sha,
        failing_checks: actionable.failing_checks,
        unresolved_review_thread_ids: actionable.unresolved_review_thread_ids,
        mergeability: actionable.mergeability,
      }),
      reaction_attempts: reactions,
    });
  }
  return projection;
}

/**
 * Advance one delivery receipt under the publication task lock. Delivery is
 * notification evidence only; it cannot authorize a repair or change session admission.
 */
export function transitionFeedbackDelivery(
  input: FeedbackIntakeInput & {
    readonly provider_event_id: string;
    readonly transition: FeedbackDeliveryTransitionInput;
  },
) {
  const gitBin = input.git_bin ?? 'git';
  const snapshot = currentPublication(input);
  try {
    return withTaskLock(input.repo_root, snapshot.receipt.task_id, () => {
      snapshot.assertCurrent();
      const current = snapshot;
      const receipt = readFeedbackDeliveryReceipt(input.repo_root, current.receipt.publication_id, input.provider_event_id, gitBin);
      if (receipt === null) throw new FeedbackError('feedback_unreadable', 'feedback delivery receipt is unavailable');
      const next = transitionFeedbackDeliveryReceipt(receipt, input.transition);
      writeFeedbackDeliveryReceipt(input.repo_root, current.receipt.publication_id, next, gitBin);
      snapshot.assertCurrent();
      return next;
    });
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    if (error instanceof FeedbackStoreError) throw new FeedbackError(error.code, error.message, error);
    throw new FeedbackError('feedback_incomplete', 'feedback delivery transition failed', error);
  }
}

/**
 * The repair envelope is ephemeral transport data.  It deliberately repeats
 * the frozen offer fences and only carries provider object identifiers; full
 * provider comment bodies never leave the feedback store through this path.
 */

function actionableFeedbackFacts(events: readonly FeedbackEventV1[]): {
  readonly failing_checks: readonly FeedbackFailingCheckV1[];
  readonly failing_check_ids: readonly string[];
  readonly unresolved_review_thread_ids: readonly string[];
  readonly changes_requested_review_ids: readonly string[];
  readonly mergeability: FeedbackMergeability;
} {
  const checks = new Map<string, FeedbackFailingCheckV1>();
  const unresolved = new Set<string>();
  const changesRequested = new Set<string>();
  const mergeabilities = new Set<FeedbackMergeability>();
  for (const event of events) {
    mergeabilities.add(event.mergeability);
    for (const check of event.failing_checks) {
      const existing = checks.get(check.id);
      if (existing !== undefined && existing.conclusion !== check.conclusion) {
        throw new FeedbackError('feedback_unreadable', `failing check ${check.id} has conflicting conclusions`);
      }
      checks.set(check.id, check);
    }
    for (const id of event.unresolved_review_thread_ids) unresolved.add(id);
    for (const id of event.changes_requested_review_ids) changesRequested.add(id);
  }
  if (mergeabilities.size !== 1) {
    throw new FeedbackError('feedback_unreadable', 'feedback material does not carry one canonical mergeability');
  }
  const failingChecks = [...checks.values()].sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
  const failingCheckIds = failingChecks.map((check) => check.id);
  return Object.freeze({
    failing_checks: Object.freeze(failingChecks),
    failing_check_ids: Object.freeze(failingCheckIds),
    unresolved_review_thread_ids: Object.freeze([...unresolved].sort(byteCompare)),
    changes_requested_review_ids: Object.freeze([...changesRequested].sort(byteCompare)),
    mergeability: [...mergeabilities][0]!,
  });
}
