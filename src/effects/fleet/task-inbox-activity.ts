import { lstatSync, opendirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  admittedTaskInboxRecipientStorageKey as taskInboxRecipientStorageKey,
  taskInboxRecipientStorageKey as historicalRecipientStorageKey,
} from '../../core/fleet/task-inbox-layout';
import {
  canonicalTaskMessageDeliveryReceiptBytes,
  canonicalTaskMessageEventBytes,
  deriveTaskMessageRecipientKey,
  validateTaskMessageDeliveryReceipt,
  validateTaskMessageEvent,
  recipientFromTaskMessageReceipt,
  type TaskMessageDeliveryReceiptV2,
  type TaskMessageEventV2,
} from '../../core/fleet/admitted-task-message';
import * as historicalMessage from '../../core/fleet/task-message';
import { newestTaskMessageFirst } from '../../core/fleet/task-message-order';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { inspectTaskInboxLayout, assertTaskInboxLayoutUnchanged } from './task-inbox-layout';
import {
  TASK_INBOX_RELATIVE_PATH,
  assertTaskId,
  assertMessageId,
  assertEventStored,
  fail,
  inspectSafeDirectoryChain,
  readCanonicalFile,
  rejectRetiredRecord,
} from './task-inbox-store';

const TASK_REPLY_RECORD_MAX_BYTES = 64 * 1024;
export class TaskReplyStoreError extends Error {
  readonly code = 'task_reply_inconsistent';
}
function replyInconsistent(message: string): never { throw new TaskReplyStoreError(message); }

function optionalReplyRecord<T>(commonDirectory: string, path: string, validate: (value: unknown) => T, canonical: (value: T) => string, charge?: (bytes: number) => void): T | null {
  if (!inspectSafeDirectoryChain(commonDirectory, dirname(path), false, 'reply record directory')) return null;
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TASK_REPLY_RECORD_MAX_BYTES) fail('task_message_unreadable', 'reply record is unsafe or exceeds its byte bound');
  charge?.(stat.size);
  const bytes = readCanonicalFile(path, 'reply record');
  let value: T;
  try { value = validate(JSON.parse(bytes)); } catch (error) { rejectRetiredRecord(error, path); throw error; }
  if (canonical(value) !== bytes) replyInconsistent('reply record is not canonical');
  return value;
}

interface TaskActivityCoverage {
  readonly complete: boolean;
  readonly reason: 'scan' | 'bytes' | 'deadline' | 'page' | null;
  readonly scanned: number;
  readonly bytes: number;
}

/** Historical correlation only; never used to authorize active delivery. */
export function readHistoricalTaskMessageDelivery(input: { repo_root: string; task_id: string; message_id: string; recipient: historicalMessage.TaskMessageRecipient }) {
  assertTaskId(input.task_id); assertMessageId(input.message_id);
  const common = resolveGitCommonDirectory(input.repo_root), layout = inspectTaskInboxLayout(common);
  const directory = join(common, TASK_INBOX_RELATIVE_PATH, input.task_id);
  const event = optionalReplyRecord(common, join(directory, 'events', `${input.message_id}.json`), historicalMessage.validateTaskMessageEvent, historicalMessage.canonicalTaskMessageEventBytes);
  if (!event || event.task_id !== input.task_id || event.message_id !== input.message_id) fail('task_message_unreadable', 'historical event unavailable');
  const receipt = optionalReplyRecord(common, join(directory, 'delivery', input.message_id, `${historicalRecipientStorageKey(input.recipient)}.json`), historicalMessage.validateTaskMessageDeliveryReceipt, historicalMessage.canonicalTaskMessageDeliveryReceiptBytes);
  if (receipt && (receipt.message_id !== event.message_id || receipt.recipient_task_revision !== event.task_revision
    || historicalMessage.deriveTaskMessageRecipientKey(historicalMessage.recipientFromTaskMessageReceipt(receipt)) !== historicalMessage.deriveTaskMessageRecipientKey(input.recipient))) fail('task_message_unreadable', 'historical receipt identity is mismatched');
  let globallySatisfied = false;
  const deliveryDirectory = join(directory, 'delivery', input.message_id);
  if (event.scope === 'task' && inspectSafeDirectoryChain(common, deliveryDirectory, false, 'historical deliveries')) {
    for (const name of readdirSync(deliveryDirectory)) {
      if (!name.endsWith('.json')) fail('task_message_unreadable', 'historical receipt filename is invalid');
      const other = optionalReplyRecord(common, join(deliveryDirectory, name), historicalMessage.validateTaskMessageDeliveryReceipt, historicalMessage.canonicalTaskMessageDeliveryReceiptBytes);
      if (!other || other.message_id !== event.message_id || other.recipient_task_revision !== event.task_revision
        || `${historicalRecipientStorageKey(historicalMessage.recipientFromTaskMessageReceipt(other))}.json` !== name) fail('task_message_unreadable', 'historical receipt path is mismatched');
      if (other.delivery_state === 'acknowledged') globallySatisfied = true;
    }
  }
  assertTaskInboxLayoutUnchanged(common, layout);
  return { event, receipt, globally_satisfied: globallySatisfied };
}

/**
 * Read-only admitted-wire activity, newest first by `created_at`, then `message_id`.
 * `after` continues that order below the named event. Recorded provenance is not current authorization.
 */
export function readAdmittedTaskActivity(input: {
  repo_root: string; task_id: string; limit: number; after: string | null; message_id: string | null;
  budget: { max_scan: number; max_bytes: number; deadline_ms: number };
}) {
  const layoutCommon = resolveGitCommonDirectory(input.repo_root);
  const layoutIdentity = inspectTaskInboxLayout(layoutCommon);
  const result = (() => {
  assertTaskId(input.task_id);
  if (input.message_id !== null) assertMessageId(input.message_id);
  if (input.after !== null) assertMessageId(input.after);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) fail('task_message_invalid', 'invalid activity limit');
  const common = resolveGitCommonDirectory(input.repo_root);
  const directory = join(common, TASK_INBOX_RELATIVE_PATH, input.task_id, 'admitted', 'events');
  const started = Date.now();
  let scanned = 0, bytes = 0;
  let exhausted: 'scan' | 'bytes' | 'deadline' | null = null;
  const stop = (reason: NonNullable<typeof exhausted>): never => { exhausted = reason; throw new Error('activity read budget exhausted'); };
  const charge = (size: number) => {
    if (Date.now() - started >= input.budget.deadline_ms) stop('deadline');
    if (bytes + size > input.budget.max_bytes) stop('bytes');
    bytes += size;
  };
  const count = () => { charge(0); if (scanned >= input.budget.max_scan) stop('scan'); scanned++; };
  const each = (path: string, visit: (name: string) => void) => {
    if (!inspectSafeDirectoryChain(common, path, false, 'historical activity directory')) return;
    const stream = opendirSync(path);
    try { for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      count();
      if (!entry.isFile() || !entry.name.endsWith('.json')) fail('task_message_unreadable', 'invalid historical activity entry');
      visit(entry.name);
    } } finally { stream.closeSync(); }
  };
  const eventAt = (id: string) => {
    assertMessageId(id);
    const event = optionalReplyRecord(common, join(directory, `${id}.json`), validateTaskMessageEvent, canonicalTaskMessageEventBytes, charge);
    if (!event) return null;
    assertEventStored(event, input.task_id);
    if (event.message_id !== id) fail('task_message_unreadable', 'historical event path identity is mismatched');
    return event;
  };
  const receiptsAt = (event: TaskMessageEventV2) => {
    const receipts: TaskMessageDeliveryReceiptV2[] = [];
    const path = join(common, TASK_INBOX_RELATIVE_PATH, input.task_id, 'admitted', 'delivery', event.message_id);
    each(path, name => {
      const receipt = optionalReplyRecord(common, join(path, name), validateTaskMessageDeliveryReceipt, canonicalTaskMessageDeliveryReceiptBytes, charge);
      if (!receipt || receipt.message_id !== event.message_id || receipt.recipient_admission_sha256 !== event.admission_sha256
        || `${taskInboxRecipientStorageKey(recipientFromTaskMessageReceipt(receipt))}.json` !== name) fail('task_message_unreadable', 'historical receipt path identity is mismatched');
      receipts.push(receipt);
    });
    return receipts.sort((a,b) => deriveTaskMessageRecipientKey(recipientFromTaskMessageReceipt(a)).localeCompare(deriveTaskMessageRecipientKey(recipientFromTaskMessageReceipt(b))));
  };
  // The walk reads events only; receipts are read only for the returned page.
  // A record is one event with all its receipts; a receipt-phase budget stop keeps the complete records, in order.
  // A walk stop returns no records: the walk saw only part of the events, so it cannot name the newest page.
  const walked: TaskMessageEventV2[] = [];
  const entries: { event: TaskMessageEventV2; receipts: TaskMessageDeliveryReceiptV2[] }[] = [];
  let cursor: TaskMessageEventV2 | null = null;
  const keep = (event: TaskMessageEventV2) => {
    if (cursor === null || newestTaskMessageFirst(cursor, event) < 0) walked.push(event);
  };
  let historyExists = inspectSafeDirectoryChain(common, directory, false, 'historical event directory');
  try {
    if (input.after !== null) {
      count(); cursor = eventAt(input.after);
      if (!cursor) fail('task_message_invalid', 'activity cursor names no stored event');
    }
    if (input.message_id !== null) { count(); const event = eventAt(input.message_id); historyExists = event !== null; if (event) keep(event); }
    else if (historyExists) each(directory, name => { const event = eventAt(name.slice(0,-5)); if (!event) fail('task_message_unreadable', 'historical event disappeared'); keep(event); });
  } catch (error) { if (!exhausted) throw error; }
  const page = exhausted ? [] : walked.sort(newestTaskMessageFirst).slice(0, input.limit);
  try {
    for (const event of page) entries.push({ event, receipts: receiptsAt(event) });
  } catch (error) { if (!exhausted) throw error; }
  const reason = exhausted ?? (walked.length > page.length ? 'page' as const : null);
  const coverage: TaskActivityCoverage = { complete: reason === null, reason, scanned, bytes };
  return { history_exists: historyExists, entries, coverage,
    next_cursor: reason === 'page' ? entries.at(-1)?.event.message_id ?? null : null };
  })();
  assertTaskInboxLayoutUnchanged(layoutCommon, layoutIdentity);
  return result;
}
