import { canonicalize } from '../evidence/canonical-json';
import { isRecord } from '../evidence/is-record';
import { SHA256_PREFIXED_PATTERN } from '../evidence/sha256-pattern';
import { sha256Prefixed } from '../evidence/sha256';

function fail(message: string, code = 1): never {
  const error = new Error(message) as Error & { exitCode?: number };
  error.exitCode = code;
  throw error;
}

/** Already-authorized upstream waiver action. References and actor strings are
 * trace data; the trusted Bot must obtain the user's separate waiver decision.
 */
export interface UserWaiverAuthorizationSubject {
  repository_root: string;
  repository_id: string;
  issue_id: string;
  campaign_id: string;
  campaign_sha256: string;
  admission_sha256: string;
  grant_sha256: string;
  goal_sha256: string;
  actor: string;
  summary: string;
}
export interface UserWaiverAuthorization extends UserWaiverAuthorizationSubject {
  protocol: 1;
  kind: 'repo-harness-upstream-waiver-authorization';
  action: 'human-approved-user-waiver';
  authorization_ref: string;
  bot_id: string;
  /** Epoch milliseconds; expiry is exclusive. */
  expires_at: number;
}

export function validateUserWaiverAuthorization(
  value: unknown, expected: UserWaiverAuthorizationSubject, now: number,
): Readonly<UserWaiverAuthorization> {
  function invalid(reason: string): never { return fail(`UserWaiverGrant upstream authorization ${reason}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('is required');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('prototype is invalid');
  const fields = ['protocol', 'kind', 'action', 'authorization_ref', 'bot_id', 'expires_at',
    'repository_root', 'repository_id', 'issue_id', 'campaign_id', 'campaign_sha256', 'admission_sha256',
    'grant_sha256', 'goal_sha256', 'actor', 'summary'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(descriptors, field))) invalid('fields are invalid');
  const detached: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field]!;
    if (!descriptor.enumerable || !('value' in descriptor)) invalid('fields must be plain data');
    detached[field] = descriptor.value;
    if (field !== 'protocol' && field !== 'expires_at'
      && (typeof descriptor.value !== 'string' || !descriptor.value.trim() || descriptor.value.includes('\0'))) invalid(`${field} is invalid`);
  }
  if (detached.protocol !== 1 || detached.kind !== 'repo-harness-upstream-waiver-authorization'
    || detached.action !== 'human-approved-user-waiver') invalid('action is invalid');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(detached.expires_at)
    || typeof detached.expires_at !== 'number' || detached.expires_at <= now) invalid('is expired');
  if (detached.bot_id === expected.actor) invalid('Bot cannot be the execution actor');
  for (const field of ['campaign_sha256', 'admission_sha256', 'grant_sha256', 'goal_sha256']) {
    if (!SHA256_PREFIXED_PATTERN.test(detached[field] as string)) invalid(`${field} is invalid`);
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (detached[field] !== expectedValue) invalid(`${field} is stale`);
  }
  return Object.freeze(detached as unknown as UserWaiverAuthorization);
}

export type UserWaiverGrant = {
  protocol: 3;
  kind: 'repo-harness-user-waiver-grant';
  repository_root: string;
  campaign_sha256: string;
  admission_sha256: string;
  grant_sha256: string;
  goal_sha256: string;
  actor: string;
  scope: 'admission-authority';
  summary: string;
  issued_at: string;
  authorization: Readonly<UserWaiverAuthorization>;
};

/** Structural metadata check. Upstream authorization is validated separately
 * against the freshly observed admission and current time before consumption. */
export function assertUserWaiverGrant(value: unknown): asserts value is UserWaiverGrant {
  if (!isRecord(value) || value.protocol !== 3 || value.kind !== 'repo-harness-user-waiver-grant') fail('UserWaiverGrant kind/protocol is invalid');
  const fields = ['protocol', 'kind', 'repository_root', 'campaign_sha256', 'admission_sha256', 'grant_sha256',
    'goal_sha256', 'actor', 'scope', 'summary', 'issued_at', 'authorization'];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))
    || !isRecord(value.authorization)) fail('UserWaiverGrant fields are invalid');
  for (const field of ['repository_root', 'campaign_sha256', 'admission_sha256', 'grant_sha256', 'goal_sha256', 'actor', 'scope', 'summary', 'issued_at']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) fail(`UserWaiverGrant ${field} is required`);
  }
  if (value.scope !== 'admission-authority') fail('UserWaiverGrant scope is invalid');
  for (const field of ['campaign_sha256', 'admission_sha256', 'grant_sha256', 'goal_sha256']) {
    if (!SHA256_PREFIXED_PATTERN.test(value[field] as string)) fail(`UserWaiverGrant ${field} is invalid`);
  }
}

export function waiverGrantFingerprint(grant: UserWaiverGrant): string {
  return sha256Prefixed(canonicalize(grant));
}
