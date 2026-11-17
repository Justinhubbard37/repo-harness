import { retiredDeliveryChannelRecord, TaskMessageError } from '../../core/messages/task-message-error';
import { TASK_INBOX_V2_RELATIVE_PATH, admittedTaskInboxRecipientStorageKey as taskInboxRecipientStorageKey } from '../../core/fleet/task-inbox-layout';
import { inspectTaskInboxLayout, TaskInboxLayoutError } from './task-inbox-layout';
import { createFileExclusiveDurably, retryWindowsSharingRace, syncDirectoryDurably } from '../atomic-append';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';
import { randomUUID } from 'crypto';
import {
  TASK_MESSAGE_BODY_MAX_BYTES,
  buildTaskMessageEvent,
  buildTaskMessageDeliveryReceipt,
  canonicalTaskMessageDeliveryReceiptBytes,
  canonicalTaskMessageEventBytes,
  deriveTaskMessageRecipientKey,
  validateTaskMessageDeliveryReceipt,
  validateTaskMessageEvent,
  recipientFromTaskMessageReceipt,
  type TaskMessageDeliveryChannel,
  type TaskMessageDeliveryReceiptV2,
  type TaskMessageEventV2,
  type TaskMessageRecipient,
} from '../../core/fleet/admitted-task-message';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { withTaskLock } from '../locking/task-lock';
import { withExclusiveDirectoryLock } from '../locking/exclusive-directory-lock';
import { newestTaskMessageFirst } from '../../core/fleet/task-message-order';

export const TASK_INBOX_RELATIVE_PATH = TASK_INBOX_V2_RELATIVE_PATH;

export type TaskInboxErrorCode =
  | 'task_message_invalid'
  | 'task_message_unreadable'
  | 'message_id_conflict'
  | 'task_revision_mismatch'
  | 'canonical_source_stale'
  | 'task_not_pending'
  | 'task_unowned'
  | 'claim_mismatch'
  | 'recipient_unavailable'
  | 'task_message_transition_invalid'
  | 'task_message_channel_retired';

export class TaskInboxError extends Error {
  constructor(readonly code: TaskInboxErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TaskInboxError';
  }
}

export interface TaskInboxEventEntry {
  readonly event: TaskMessageEventV2;
  readonly receipt: TaskMessageDeliveryReceiptV2 | null;
  readonly globally_satisfied: boolean;
}

export interface TaskInboxSendResult {
  readonly event: TaskMessageEventV2;
  readonly event_path: string;
  readonly created: boolean;
}

function asInboxError(error: unknown, fallback: TaskInboxErrorCode, context: string): TaskInboxError {
  if (error instanceof TaskInboxError) return error;
  if (error instanceof TaskMessageError) return new TaskInboxError(error.code, error.message, error);
  if (error instanceof TaskInboxLayoutError) return new TaskInboxError('task_message_unreadable', error.message, error);
  return new TaskInboxError(fallback, context, error);
}

function fail(code: TaskInboxErrorCode, message: string, cause?: unknown): never {
  throw new TaskInboxError(code, message, cause);
}

function withInboxTaskLock<T>(repoRoot: string, taskId: string, action: () => T): T {
  try {
    const common = resolveGitCommonDirectory(repoRoot);
    // Share the offline migration mutex, including writers for task directories
    // that were not present when its inventory was captured. Always acquire it
    // before the unchanged physical task lock, as the migration does.
    return withExclusiveDirectoryLock(common, 'repo-harness/task-inbox-migration.lock', () =>
      withTaskLock(repoRoot, taskId, () => {
        inspectTaskInboxLayout(common);
        const result = action();
        inspectTaskInboxLayout(common);
        return result;
      }));
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot operate task inbox under the task lock for ${taskId}`);
  }
}

function taskInboxRoot(repoRoot: string): string {
  const common = resolveGitCommonDirectory(repoRoot);
  inspectTaskInboxLayout(common);
  return join(common, TASK_INBOX_RELATIVE_PATH);
}

/** Crash residue is not a canonical record and must never enter strict scans. */
function taskInboxStagingDirectory(repoRoot: string, taskId: string, kind: 'events' | 'delivery'): string {
  return join(taskInboxTaskDirectory(repoRoot, taskId), 'staging', kind);
}

export function taskInboxTaskDirectory(repoRoot: string, taskId: string): string {
  return taskInboxTaskScope(repoRoot, taskId).directory;
}

/**
 * One task's inbox location, resolved once. Resolving the common directory
 * spawns Git, so a scan carries this value instead of resolving it again for
 * every event it reads.
 */
interface TaskInboxTaskScope {
  readonly common: string;
  readonly task_id: string;
  readonly directory: string;
}

function taskInboxTaskScope(repoRoot: string, taskId: string): TaskInboxTaskScope {
  assertTaskId(taskId);
  const common = resolveGitCommonDirectory(repoRoot);
  inspectTaskInboxLayout(common);
  return { common, task_id: taskId, directory: join(common, TASK_INBOX_RELATIVE_PATH, taskId, 'admitted') };
}

export function taskInboxEventPath(repoRoot: string, taskId: string, messageId: string): string {
  assertTaskId(taskId);
  assertMessageId(messageId);
  return join(taskInboxTaskDirectory(repoRoot, taskId), 'events', `${messageId}.json`);
}

export function taskInboxDeliveryPath(
  repoRoot: string,
  taskId: string,
  messageId: string,
  recipient: TaskMessageRecipient,
): string {
  assertTaskId(taskId);
  assertMessageId(messageId);
  return join(taskInboxTaskDirectory(repoRoot, taskId), 'delivery', messageId, `${taskInboxRecipientStorageKey(recipient)}.json`);
}

function assertTaskId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) fail('task_message_invalid', `task id is invalid: ${JSON.stringify(value)}`);
}

function assertMessageId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    fail('task_message_invalid', `message id is invalid: ${JSON.stringify(value)}`);
  }
}

function inboxPathSegments(commonDirectory: string, path: string): string[] {
  const rel = relative(commonDirectory, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    fail('task_message_unreadable', `task inbox path escapes the git common directory: ${path}`);
  }
  return rel.split(/[\\/]/u).filter(Boolean);
}

/** Walk every component with lstat so an ancestor symlink cannot redirect inbox I/O. */
function inspectSafeDirectoryChain(commonDirectory: string, path: string, create: boolean, context: string): boolean {
  let current = commonDirectory;
  for (const segment of inboxPathSegments(commonDirectory, path)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw asInboxError(error, 'task_message_unreadable', `cannot inspect ${context}: ${current}`);
      }
      if (!create) return false;
      try {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      } catch (mkdirError) {
        throw asInboxError(mkdirError, 'task_message_unreadable', `cannot prepare ${context}: ${current}`);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('task_message_unreadable', `${context} is unsafe: ${current}`);
  }
  return true;
}

function assertRegular(path: string, context: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot inspect ${context}: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('task_message_unreadable', `${context} is unsafe: ${path}`);
}

function readCanonicalFile(path: string, context: string): string {
  assertRegular(path, context);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot read ${context}: ${path}`);
  }
  if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n\n')) {
    fail('task_message_unreadable', `${context} does not have canonical record framing: ${path}`);
  }
  return raw.slice(0, -1);
}

function readEventAt(path: string): TaskMessageEventV2 {
  let event: TaskMessageEventV2;
  try {
    event = validateTaskMessageEvent(JSON.parse(readCanonicalFile(path, 'task message event')));
  } catch (error) {
    throw new TaskInboxError('task_message_unreadable', `task message event is malformed: ${path}`, error);
  }
  if (canonicalTaskMessageEventBytes(event) !== readCanonicalFile(path, 'task message event')) {
    fail('task_message_unreadable', `task message event is not canonical: ${path}`);
  }
  return event;
}

function rejectRetiredRecord(error: unknown, path: string): void {
  if (error instanceof TaskMessageError && error.code === 'task_message_channel_retired') {
    fail('task_message_unreadable', retiredDeliveryChannelRecord(path));
  }
}

function readReceiptAt(path: string): TaskMessageDeliveryReceiptV2 {
  let receipt: TaskMessageDeliveryReceiptV2;
  try {
    receipt = validateTaskMessageDeliveryReceipt(JSON.parse(readCanonicalFile(path, 'task message delivery receipt')));
  } catch (error) {
    rejectRetiredRecord(error, path);
    throw new TaskInboxError('task_message_unreadable', `task message delivery receipt is malformed: ${path}`, error);
  }
  if (canonicalTaskMessageDeliveryReceiptBytes(receipt) !== readCanonicalFile(path, 'task message delivery receipt')) {
    fail('task_message_unreadable', `task message delivery receipt is not canonical: ${path}`);
  }
  return receipt;
}

function readOptionalReceipt(
  repoRoot: string,
  taskId: string,
  messageId: string,
  recipient: TaskMessageRecipient,
): TaskMessageDeliveryReceiptV2 | null {
  const path = taskInboxDeliveryPath(repoRoot, taskId, messageId, recipient);
  if (!existsSync(path)) return null;
  const receipt = readReceiptAt(path);
  if (receipt.message_id !== messageId || deriveTaskMessageRecipientKey(recipientFromReceipt(receipt)) !== deriveTaskMessageRecipientKey(recipient)) {
    fail('task_message_unreadable', `task message delivery receipt identity is mismatched: ${path}`);
  }
  return receipt;
}

function recipientFromReceipt(receipt: TaskMessageDeliveryReceiptV2): TaskMessageRecipient {
  return recipientFromTaskMessageReceipt(receipt);
}

function listEvents(scope: TaskInboxTaskScope): TaskMessageEventV2[] {
  const taskId = scope.task_id;
  const directory = join(scope.directory, 'events');
  if (!inspectSafeDirectoryChain(scope.common, directory, false, 'task message event directory')) return [];
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot inspect task message event directory: ${directory}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('task_message_unreadable', `task message event directory is unsafe: ${directory}`);
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot list task message events: ${directory}`);
  }
  const events: TaskMessageEventV2[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(name)) {
      fail('task_message_unreadable', `task message event filename is invalid: ${name}`);
    }
    const event = readEventAt(join(directory, name));
    if (`${event.message_id}.json` !== name || event.task_id !== taskId) {
      fail('task_message_unreadable', `task message event path identity is mismatched: ${name}`);
    }
    events.push(event);
  }
  // Oldest first: the inbox order, reversed.
  return events.sort((left, right) => newestTaskMessageFirst(right, left));
}

function listReceipts(scope: TaskInboxTaskScope, messageId: string): TaskMessageDeliveryReceiptV2[] {
  const directory = join(scope.directory, 'delivery', messageId);
  if (!inspectSafeDirectoryChain(scope.common, directory, false, 'task message delivery directory')) return [];
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot inspect task message delivery directory: ${directory}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('task_message_unreadable', `task message delivery directory is unsafe: ${directory}`);
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    throw asInboxError(error, 'task_message_unreadable', `cannot list task message receipts: ${directory}`);
  }
  return names.map((name) => {
    if (!name.endsWith('.json')) fail('task_message_unreadable', `task message delivery filename is invalid: ${name}`);
    const receipt = readReceiptAt(join(directory, name));
    if (receipt.message_id !== messageId || `${taskInboxRecipientStorageKey(recipientFromReceipt(receipt))}.json` !== name) {
      fail('task_message_unreadable', `task message delivery path identity is mismatched: ${name}`);
    }
    return receipt;
  });
}

function ensureInboxDirectories(repoRoot: string, taskId: string, messageId?: string): void {
  const commonDirectory = resolveGitCommonDirectory(repoRoot);
  const root = taskInboxRoot(repoRoot);
  inspectSafeDirectoryChain(commonDirectory, root, true, 'task inbox root');
  const taskDirectory = taskInboxTaskDirectory(repoRoot, taskId);
  inspectSafeDirectoryChain(commonDirectory, taskDirectory, true, 'task inbox task directory');
  inspectSafeDirectoryChain(commonDirectory, join(taskDirectory, 'events'), true, 'task inbox event directory');
  inspectSafeDirectoryChain(commonDirectory, taskInboxStagingDirectory(repoRoot, taskId, 'events'), true, 'task inbox event staging directory');
  if (messageId) {
    inspectSafeDirectoryChain(commonDirectory, join(taskDirectory, 'delivery'), true, 'task inbox delivery root');
    inspectSafeDirectoryChain(commonDirectory, join(taskDirectory, 'delivery', messageId), true, 'task inbox delivery directory');
    inspectSafeDirectoryChain(commonDirectory, taskInboxStagingDirectory(repoRoot, taskId, 'delivery'), true, 'task inbox delivery staging directory');
  }
}

function writeImmutableEvent(repoRoot: string, event: TaskMessageEventV2): TaskInboxSendResult {
  ensureInboxDirectories(repoRoot, event.task_id);
  const target = taskInboxEventPath(repoRoot, event.task_id, event.message_id);
  const canonical = canonicalTaskMessageEventBytes(event);
  if (existsSync(target)) {
    const existing = readEventAt(target);
    if (!sameEventRetry(existing, event)) {
      fail('message_id_conflict', `task message id ${event.message_id} conflicts with existing immutable event`);
    }
    return { event: existing, event_path: target, created: false };
  }
  const directory = dirname(target);
  const temporary = join(
    taskInboxStagingDirectory(repoRoot, event.task_id, 'events'),
    `.${event.message_id}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${canonical}\n`, 'utf-8');
  createFileExclusiveDurably(temporary, bytes, 0o600, (error) => asInboxError(error, 'task_message_unreadable', `cannot persist task message event: ${target}`));
  try {
    inspectTaskInboxLayout(resolveGitCommonDirectory(repoRoot));
    try {
      linkSync(temporary, target);
      syncDirectoryDurably(directory);
      return { event, event_path: target, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = readEventAt(target);
        if (!sameEventRetry(existing, event)) {
          fail('message_id_conflict', `task message id ${event.message_id} conflicts with existing immutable event`);
        }
        return { event: existing, event_path: target, created: false };
      }
      throw asInboxError(error, 'task_message_unreadable', `cannot publish task message event: ${target}`);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw asInboxError(error, 'task_message_unreadable', `cannot clean task message temporary: ${temporary}`);
    }
  }
}

/**
 * A caller cannot know the first write's timestamp when retrying after a
 * crash. It is therefore the sole immutable field sourced from the incumbent;
 * every other field, including both byte digests, must still agree exactly.
 */
function sameEventRetry(existing: TaskMessageEventV2, candidate: TaskMessageEventV2): boolean {
  const rebased = buildTaskMessageEvent({
    message_id: candidate.message_id,
    task_id: candidate.task_id,
    admission_sha256: candidate.admission_sha256,
    scope: candidate.scope,
    target_claim: candidate.target_claim,
    task_identity: candidate.task_identity,
    sender_kind: candidate.sender_kind,
    sender_id: candidate.sender_id,
    sender_trust: candidate.sender_trust,
    audience: candidate.audience,
    body: candidate.body,
    created_at: existing.created_at,
    in_reply_to: candidate.in_reply_to,
  });
  return canonicalTaskMessageEventBytes(existing) === canonicalTaskMessageEventBytes(rebased);
}

function writeReceipt(repoRoot: string, taskId: string, receipt: TaskMessageDeliveryReceiptV2): TaskMessageDeliveryReceiptV2 {
  const recipient = recipientFromReceipt(receipt);
  ensureInboxDirectories(repoRoot, taskId, receipt.message_id);
  const target = taskInboxDeliveryPath(repoRoot, taskId, receipt.message_id, recipient);
  if (existsSync(target)) readReceiptAt(target);
  const canonical = canonicalTaskMessageDeliveryReceiptBytes(receipt);
  const directory = dirname(target);
  const temporary = join(
    taskInboxStagingDirectory(repoRoot, taskId, 'delivery'),
    `.${receipt.message_id}.${taskInboxRecipientStorageKey(recipient)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${canonical}\n`, 'utf-8');
  try {
    try {
      createFileExclusiveDurably(temporary, bytes);
    } catch (error) {
      throw asInboxError(error, 'task_message_unreadable', `cannot stage task message delivery receipt: ${target}`);
    }
    inspectTaskInboxLayout(resolveGitCommonDirectory(repoRoot));
    try {
      retryWindowsSharingRace(() => renameSync(temporary, target));
      syncDirectoryDurably(directory);
    } catch (error) {
      throw asInboxError(error, 'task_message_unreadable', `cannot persist task message delivery receipt: ${target}`);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw asInboxError(error, 'task_message_unreadable', `cannot clean task message receipt temporary: ${temporary}`);
    }
  }
  return receipt;
}

function assertEventStored(event: { task_id: string; message_id: string; body: string }, taskId: string): void {
  if (event.task_id !== taskId) fail('task_message_unreadable', `task message event ${event.message_id} is in the wrong task directory`);
  if (Buffer.byteLength(event.body, 'utf-8') > TASK_MESSAGE_BODY_MAX_BYTES) fail('task_message_unreadable', `task message event ${event.message_id} body exceeds its limit`);
}

/** Fails closed where the caller names one exact event and revision. */
function assertEventCanonical(event: TaskMessageEventV2, taskId: string, revision: string): void {
  assertEventStored(event, taskId);
  if (event.admission_sha256 !== revision) fail('task_revision_mismatch', `task message event ${event.message_id} revision is stale`);
}

/**
 * A scan reads every admitted event of one task. A replaced admission makes
 * earlier events no longer addressed to the current task context: they are skipped, and
 * is neither listed, delivered, nor counted. Aborting the whole scan instead
 * let one superseded event hide the entire inbox permanently -- and, through
 * the fleet card's inbox observation, the entire repository.
 */
function isCurrentRevisionEvent(event: TaskMessageEventV2, taskId: string, revision: string): boolean {
  assertEventStored(event, taskId);
  return event.admission_sha256 === revision;
}

function isGloballySatisfied(repoRoot: string, taskId: string, event: TaskMessageEventV2): boolean {
  if (event.scope !== 'task') return false;
  return listReceipts(taskInboxTaskScope(repoRoot, taskId), event.message_id).some((receipt) => receipt.delivery_state === 'acknowledged');
}

function receiptFor(
  repoRoot: string,
  taskId: string,
  event: TaskMessageEventV2,
  recipient: TaskMessageRecipient,
  channel: TaskMessageDeliveryChannel,
): TaskMessageDeliveryReceiptV2 {
  return readOptionalReceipt(repoRoot, taskId, event.message_id, recipient)
    ?? buildTaskMessageDeliveryReceipt({
      message_id: event.message_id,
      recipient,
      admission_sha256: event.admission_sha256,
      delivery_channel: channel,
    });
}

export {
  asInboxError,
  fail,
  withInboxTaskLock,
  taskInboxTaskScope,
  assertTaskId,
  assertMessageId,
  inspectSafeDirectoryChain,
  readCanonicalFile,
  readEventAt,
  rejectRetiredRecord,
  readOptionalReceipt,
  listEvents,
  writeImmutableEvent,
  writeReceipt,
  assertEventStored,
  assertEventCanonical,
  isCurrentRevisionEvent,
  isGloballySatisfied,
  receiptFor,
};
