import { sameTaskMessageClaim } from '../../core/messages/task-message-claim';
import { inspectTaskInboxLayout, assertTaskInboxLayoutUnchanged } from './task-inbox-layout';
import { realpathSync } from 'fs';
import {
  TASK_MESSAGE_HOOK_MAX_BYTES,
  TASK_MESSAGE_HOOK_MAX_MESSAGES,
  canonicalTaskMessageDeliveryReceiptBytes,
  renderTaskMessageUntrustedContext,
  transitionTaskMessageDeliveryReceipt,
  validateTaskMessageEvent,
  type TaskMessageDeliveryChannel,
  type TaskMessageDeliveryReceiptV2,
  type TaskMessageEventV2,
  type TaskMessageRecipient,
} from '../../core/fleet/admitted-task-message';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { observeCurrentTaskSession, type CurrentTaskSession } from '../terminal/task-session-admission';
import type { TaskSessionAuthority } from '../admission/admission-source';
import type { TaskSessionAdmission } from '../../core/review/runner-port';
import { canonicalize } from '../../core/evidence/canonical-json';
import type { JsonValue } from '../../core/evidence/types';
import {
  asInboxError,
  fail,
  withInboxTaskLock,
  taskInboxTaskScope,
  taskInboxEventPath,
  assertTaskId,
  assertMessageId,
  readEventAt,
  readOptionalReceipt,
  listEvents,
  writeImmutableEvent,
  writeReceipt,
  assertEventCanonical,
  isCurrentRevisionEvent,
  isGloballySatisfied,
  receiptFor,
  type TaskInboxEventEntry,
  type TaskInboxSendResult,
} from './task-inbox-store';

export {
  TASK_INBOX_RELATIVE_PATH,
  TaskInboxError,
  taskInboxTaskDirectory,
  taskInboxEventPath,
  taskInboxDeliveryPath,
  type TaskInboxErrorCode,
  type TaskInboxEventEntry,
  type TaskInboxSendResult,
} from './task-inbox-store';
export { TaskReplyStoreError, readHistoricalTaskMessageDelivery, readAdmittedTaskActivity } from './task-inbox-activity';

export interface TaskInboxSessionSource {
  readonly authority: TaskSessionAuthority;
  readonly session: { readonly task: string; readonly role: string };
}

export interface SendTaskMessageInput {
  readonly repo_root: string;
  readonly source: TaskInboxSessionSource;
  readonly event: TaskMessageEventV2;
}

export interface TaskInboxListInput {
  readonly repo_root: string;
  readonly task_id: string;
  readonly source: TaskInboxSessionSource;
  readonly recipient: TaskMessageRecipient;
  /** Required only for owner delivery/listing. It must be the bound worktree. */
  readonly execution_worktree?: string;
}

export interface DeliverTaskInboxInput extends TaskInboxListInput {
  readonly delivery_channel: TaskMessageDeliveryChannel;
  /** Required exactly when the delivery channel is one controlled request or Agent Runtime effect's
   * Host action; it is the bounded control reference that later proves this
   * effect's delivery. Forbidden for human-facing channels. An effect
   * delivery marks exactly its own message and never the whole hook lane. */
  readonly delivery_ref?: string;
  readonly message_id?: string;
  readonly delivered_at: string;
}

export interface AcknowledgeTaskInboxInput extends TaskInboxListInput {
  readonly message_id: string;
  readonly acknowledged_at: string;
}

export interface TaskInboxListResult {
  readonly task_id: string;
  readonly entries: readonly TaskInboxEventEntry[];
  /** Audience-matching events skipped because their task revision is superseded. */
  readonly superseded_revision_count: number;
}

export interface TaskInboxDelivery {
  readonly event: TaskMessageEventV2;
  readonly receipt: TaskMessageDeliveryReceiptV2;
}

export interface TaskInboxDeliveryResult {
  readonly task_id: string;
  /** Only new deliveries. An already-delivered receipt is never rendered again. */
  readonly deliveries: readonly TaskInboxDelivery[];
  readonly superseded_count: number;
  readonly pending_count: number;
  readonly rendered_body_bytes: number;
}

function sameData(left: unknown, right: unknown): boolean {
  return canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
}
function observeInboxAdmission(input: { repo_root: string; source: TaskInboxSessionSource; task_id: string }): CurrentTaskSession {
  assertTaskId(input.task_id);
  if (!input.source || input.source.session.task !== input.task_id) fail('claim_mismatch', 'explicit session task does not match inbox');
  return observeCurrentTaskSession(input, fail);
}
/** Read-only request preparation for trusted control clients. */
export function observeTaskInboxContext(input: { repo_root: string; source: TaskInboxSessionSource; task_id: string }): TaskSessionAdmission {
  return observeInboxAdmission(input).admission;
}
function audienceMatches(event: TaskMessageEventV2, recipient: TaskMessageRecipient): boolean {
  return event.audience === (recipient.kind === 'claim' ? 'owner' : recipient.kind);
}
function assertInboxRecipient(input: TaskInboxListInput, admission: TaskSessionAdmission): string {
  if (input.recipient.kind === 'claim') {
    if (!sameTaskMessageClaim(input.recipient.claim, admission.identity.claim)) fail('claim_mismatch', 'recipient does not match admitted claim reference');
    if (!input.execution_worktree || realpathSync(input.execution_worktree) !== admission.identity.execution_root) fail('recipient_unavailable', 'recipient worktree does not match admitted session');
  }
  return admission.approval.admission_sha256;
}

/** Persist a producer-authorized event after canonical task and claim checks. */
export function sendTaskMessage(input: SendTaskMessageInput): TaskInboxSendResult {
  let event: TaskMessageEventV2;
  try {
    event = validateTaskMessageEvent(input.event);
  } catch (error) {
    throw asInboxError(error, 'task_message_invalid', 'task message event is invalid');
  }
  const observed = observeInboxAdmission({ ...input, task_id: event.task_id });
  return withInboxTaskLock(input.repo_root, event.task_id, () => {
    observed.assertLocalCurrent();
    const current = observed.admission;
    if (event.admission_sha256 !== current.approval.admission_sha256
      || !sameData(event.task_identity, { repository_id: current.identity.repository_id, issue_id: current.identity.issue_id, campaign_id: current.identity.campaign_id })) fail('task_revision_mismatch', 'message does not match current admitted task');
    if (event.scope === 'claim' && !sameTaskMessageClaim(event.target_claim, current.identity.claim)) fail('claim_mismatch', 'message does not match current immutable claim');
    const result = writeImmutableEvent(input.repo_root, event);
    observed.assertLocalCurrent();
    return result;
  });
}

/** Read-only projection for a canonical recipient. It never marks delivery. */
export function listTaskInbox(input: TaskInboxListInput): TaskInboxListResult {
  assertTaskId(input.task_id);
  const observed = observeInboxAdmission(input);
  return withInboxTaskLock(input.repo_root, input.task_id, () => {
    observed.assertLocalCurrent();
    const expectedRevision = assertInboxRecipient(input, observed.admission);
    let supersededRevisionCount = 0;
    const entries = listEvents(taskInboxTaskScope(input.repo_root, input.task_id))
      .filter((event) => audienceMatches(event, input.recipient))
      .map((event) => {
        if (!isCurrentRevisionEvent(event, input.task_id, expectedRevision)) {
          supersededRevisionCount += 1;
          return null;
        }
        if (event.scope === 'claim' && (input.recipient.kind !== 'claim'
          || !sameTaskMessageClaim(event.target_claim, input.recipient.claim))) return null;
        return {
          event,
          receipt: readOptionalReceipt(input.repo_root, input.task_id, event.message_id, input.recipient),
          globally_satisfied: isGloballySatisfied(input.repo_root, input.task_id, event),
        } satisfies TaskInboxEventEntry;
      })
      .filter((entry): entry is TaskInboxEventEntry => entry !== null);
    observed.assertLocalCurrent();
    return { task_id: input.task_id, entries, superseded_revision_count: supersededRevisionCount };
  });
}

/** Read one exact Task message/recipient receipt pair for runtime correlation.
 * This adds no delivery transition and preserves Task Inbox as the authority. */
export function readTaskMessageDelivery(input: TaskInboxListInput & { readonly message_id: string }): TaskInboxEventEntry {
  const observed = observeInboxAdmission(input);
  const revision = assertInboxRecipient(input, observed.admission);
  const layoutCommon = resolveGitCommonDirectory(input.repo_root);
  const layoutIdentity = inspectTaskInboxLayout(layoutCommon);
  const result = (() => {
  observed.assertLocalCurrent();
  const event = readEventAt(taskInboxEventPath(input.repo_root, input.task_id, input.message_id));
  if (event.task_id !== input.task_id || event.message_id !== input.message_id) {
    fail('task_message_invalid', 'message does not belong to the requested Task inbox');
  }
  assertEventCanonical(event, input.task_id, revision);
  const receipt = readOptionalReceipt(input.repo_root, input.task_id, input.message_id, input.recipient);
  observed.assertLocalCurrent();
  return Object.freeze({
    event,
    receipt,
    globally_satisfied: receipt?.delivery_state === 'acknowledged',
  });
  })();
  assertTaskInboxLayoutUnchanged(layoutCommon, layoutIdentity);
  return result;
}

/**
 * Fence the recipient, supersede stale claim messages, and durably mark
 * eligible events delivered before returning them. Hook delivery is bounded;
 * a controlled manual listing is the delivery boundary for all matching rows.
 */
export function deliverTaskInbox(input: DeliverTaskInboxInput): TaskInboxDeliveryResult {
  const recipient = input.recipient;
  assertTaskId(input.task_id);
  if (input.delivery_channel === 'controlled_request') {
    if (input.delivery_ref === undefined || input.delivery_ref.length === 0) {
      fail('task_message_invalid', 'controlled delivery requires its bounded control reference');
    }
    if (input.message_id === undefined) {
      fail('task_message_invalid', 'controlled delivery requires its exact message_id');
    }
  } else if (input.delivery_ref !== undefined || input.message_id !== undefined) {
    fail('task_message_invalid', 'only controlled delivery carries a bounded control reference');
  }
  if (input.delivery_channel !== 'controlled_request' && input.delivery_ref !== undefined) {
    fail('task_message_invalid', 'only controlled delivery carries a bounded control reference');
  }
  const observed = observeInboxAdmission(input);
  return withInboxTaskLock(input.repo_root, input.task_id, () => {
    observed.assertLocalCurrent();
    const expectedRevision = assertInboxRecipient(input, observed.admission);
    const deliveries: TaskInboxDelivery[] = [];
    let supersededCount = 0;
    let pendingCount = 0;
    let renderedBodyBytes = 0;
    for (const event of listEvents(taskInboxTaskScope(input.repo_root, input.task_id))) {
      if (!isCurrentRevisionEvent(event, input.task_id, expectedRevision)) continue;
      if (!audienceMatches(event, recipient)) continue;
      if (event.scope === 'claim' && recipient.kind === 'claim'
        && (!sameTaskMessageClaim(event.target_claim, recipient.claim))) {
        const frozenRecipient: TaskMessageRecipient = {
          kind: 'claim', claim: event.target_claim!,
        };
        const prior = receiptFor(input.repo_root, input.task_id, event, frozenRecipient, input.delivery_channel);
        if (prior.delivery_state === 'acknowledged') continue;
        const next = transitionTaskMessageDeliveryReceipt(prior, { state: 'superseded' });
        if (canonicalTaskMessageDeliveryReceiptBytes(prior) !== canonicalTaskMessageDeliveryReceiptBytes(next)) {
          writeReceipt(input.repo_root, input.task_id, next);
          supersededCount += 1;
        }
        continue;
      }
      if (isGloballySatisfied(input.repo_root, input.task_id, event)) continue;
      if (input.delivery_channel === 'controlled_request' && event.message_id !== input.message_id) continue;
      const prior = receiptFor(input.repo_root, input.task_id, event, recipient, input.delivery_channel);
      if (prior.delivery_state === 'acknowledged' || prior.delivery_state === 'superseded' || prior.delivery_state === 'delivered') continue;
      const bodyBytes = Buffer.byteLength(event.body, 'utf-8');
      const candidateEvents = [...deliveries.map((delivery) => delivery.event), event];
      const renderedBytes = Buffer.byteLength(renderTaskMessageUntrustedContext(candidateEvents), 'utf-8');
      if (input.delivery_channel === 'hook_session'
        && (deliveries.length >= TASK_MESSAGE_HOOK_MAX_MESSAGES || renderedBytes > TASK_MESSAGE_HOOK_MAX_BYTES)) {
        pendingCount += 1;
        continue;
      }
      const delivered = transitionTaskMessageDeliveryReceipt(prior, input.delivery_channel === 'controlled_request'
        ? { state: 'delivered', at: input.delivered_at, delivery_ref: input.delivery_ref, delivery_channel: input.delivery_channel }
        : { state: 'delivered', at: input.delivered_at, delivery_channel: input.delivery_channel });
      writeReceipt(input.repo_root, input.task_id, delivered);
      deliveries.push({ event, receipt: delivered });
      renderedBodyBytes += bodyBytes;
    }
    observed.assertLocalCurrent();
    return {
      task_id: input.task_id,
      deliveries,
      superseded_count: supersededCount,
      pending_count: pendingCount,
      rendered_body_bytes: renderedBodyBytes,
    };
  });
}

/** Acknowledge a delivered message; a task-scoped acknowledgement globally satisfies it. */
export function acknowledgeTaskInbox(input: AcknowledgeTaskInboxInput): TaskMessageDeliveryReceiptV2 {
  assertTaskId(input.task_id);
  assertMessageId(input.message_id);
  const observed = observeInboxAdmission(input);
  return withInboxTaskLock(input.repo_root, input.task_id, () => {
    observed.assertLocalCurrent();
    const expectedRevision = assertInboxRecipient(input, observed.admission);
    const event = readEventAt(taskInboxEventPath(input.repo_root, input.task_id, input.message_id));
    assertEventCanonical(event, input.task_id, expectedRevision);
    if (!audienceMatches(event, input.recipient)) fail('recipient_unavailable', 'message audience does not match recipient');
    if (event.scope === 'claim' && (input.recipient.kind !== 'claim'
      || !sameTaskMessageClaim(event.target_claim, input.recipient.claim))) {
      fail('claim_mismatch', 'claim-scoped message does not match recipient');
    }
    const receipt = readOptionalReceipt(input.repo_root, input.task_id, input.message_id, input.recipient);
    if (receipt === null) fail('recipient_unavailable', 'message has not been delivered to recipient');
    const acknowledged = transitionTaskMessageDeliveryReceipt(receipt, { state: 'acknowledged', at: input.acknowledged_at });
    if (canonicalTaskMessageDeliveryReceiptBytes(receipt) !== canonicalTaskMessageDeliveryReceiptBytes(acknowledged)) {
      writeReceipt(input.repo_root, input.task_id, acknowledged);
    }
    observed.assertLocalCurrent();
    return acknowledged;
  });
}

/** CLI-facing spelling retained at the effect boundary. */
export const ackTaskInbox = acknowledgeTaskInbox;

