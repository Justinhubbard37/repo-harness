import { useCallback, useState } from 'react';
import type { RoutingClass } from '../core/board/seats-settings';
import { RULES_PROMOTE_KIND } from '../core/ci/rule-prompt';
import {
  decodeRulesSnapshot,
  RULES_UNAVAILABLE_REASONS,
  type RulesSnapshotV1,
  type RulesUnavailableReason,
} from '../core/operator/rules';
import { readJson } from './json-read';
import { asApiError, type OperatorApiErrorV1 } from './operator-api-error';
import { postOperatorWrite, type OperatorWriteAnswer } from './operator-write';
import { answered, useObservationRefresh } from './useObservationRefresh';

/** `unreachable` covers a request with no typed answer: no response, or a body that is not a typed refusal. */
export type RulesReason = RulesUnavailableReason | 'unreachable';

/**
 * The Rules page's read of one repository: a decoded snapshot, a known route
 * refusal, or a typed refusal whose code this bundle does not know, which the
 * page shows as the server's own code and message.
 */
export type RulesRead =
  | { readonly state: 'ok'; readonly snapshot: RulesSnapshotV1 }
  | { readonly state: 'unavailable'; readonly reason: RulesReason }
  | { readonly state: 'refused'; readonly code: string; readonly message: string };

export type RulesReader = (repositoryId: string, signal: AbortSignal) => Promise<RulesRead>;

const UNTYPED: OperatorApiErrorV1 = { code: '', message: '', next_action: '' };

function refusal(body: unknown): RulesRead {
  const error = asApiError(body, UNTYPED);
  if (error === UNTYPED) return { state: 'unavailable', reason: 'unreachable' };
  return (RULES_UNAVAILABLE_REASONS as readonly string[]).includes(error.code)
    ? { state: 'unavailable', reason: error.code as RulesUnavailableReason }
    : { state: 'refused', code: error.code, message: error.message };
}

/** One GET of the cached rules route; a body the shared decoder rejects is `rules_invalid`. */
export async function fetchRulesSnapshot(repositoryId: string, signal: AbortSignal): Promise<RulesRead> {
  const answer = await readJson(`/api/v1/repositories/${encodeURIComponent(repositoryId)}/rules`, signal);
  if (answer.state === 'unreachable') return { state: 'unavailable', reason: 'unreachable' };
  const { body } = answer;
  if (!answer.ok) return refusal(body);
  try { return { state: 'ok', snapshot: decodeRulesSnapshot(body) }; } catch { return { state: 'unavailable', reason: 'rules_invalid' }; }
}

/** The read of the selected repository; null until it settles. */
export function useRulesSnapshot(read: RulesReader, repositoryId: string | null, generation: number): RulesRead | null {
  const [state, setState] = useState<{ readonly id: string; readonly read: RulesRead } | null>(null);
  const observe = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    if (repositoryId === null) return false;
    const result = await read(repositoryId, signal);
    if (signal.aborted) return false;
    setState({ id: repositoryId, read: result });
    return answered(result);
  }, [read, repositoryId]);
  useObservationRefresh(observe, JSON.stringify(['rules-snapshot', repositoryId, generation]), { enabled: repositoryId !== null });
  return state !== null && state.id === repositoryId ? state.read : null;
}

/** The answer of `rules_promote` and `rules_reconcile`: the issue of the candidate and what each step did. */
export interface RulesPromotionV1 {
  readonly candidate_id: string;
  readonly issue: number;
  readonly url: string;
  readonly steps: {
    readonly issue: 'created' | 'found';
    readonly label: 'added' | 'present';
    readonly sub_issue: 'linked' | 'present';
  };
}

export interface RulesPromoteBody {
  readonly request_id: string;
  readonly candidate_id: string;
  readonly route: RoutingClass;
  readonly ledger_blob: string;
  readonly prompt: string;
}
export interface RulesReconcileBody {
  readonly request_id: string;
  readonly candidate_id: string;
}
export type RulesPromotionWrite = OperatorWriteAnswer<RulesPromotionV1>;
export type RulesPromoteWriter = (repositoryId: string, body: RulesPromoteBody) => Promise<RulesPromotionWrite>;
export type RulesReconcileWriter = (repositoryId: string, body: RulesReconcileBody) => Promise<RulesPromotionWrite>;

const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/u;
const keysOf = (value: unknown): string => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '');

/** The closed result document of `rh rules promote --json`, for the candidate the request named. */
function decodePromotion(candidateId: string) {
  return (value: unknown): RulesPromotionV1 => {
    const row = value as Record<string, unknown>;
    const steps = row?.steps as Record<string, unknown> | undefined;
    if (keysOf(value) !== 'candidate_id,issue,kind,parent,prompt_sha256,protocol,steps,url' || keysOf(steps) !== 'issue,label,sub_issue'
      || row.kind !== RULES_PROMOTE_KIND || row.protocol !== 1 || row.candidate_id !== candidateId
      || !Number.isSafeInteger(row.issue) || (row.issue as number) <= 0 || typeof row.url !== 'string' || !ISSUE_URL.test(row.url)
      || !['created', 'found'].includes(steps!.issue as string) || !['added', 'present'].includes(steps!.label as string)
      || !['linked', 'present'].includes(steps!.sub_issue as string)) throw new Error('rules promotion answer invalid');
    return { candidate_id: candidateId, issue: row.issue as number, url: row.url, steps: steps as unknown as RulesPromotionV1['steps'] };
  };
}

const promotionsPath = (repositoryId: string) => `/api/v1/repositories/${encodeURIComponent(repositoryId)}/rules/promotions`;
export const postRulesPromote: RulesPromoteWriter = (repositoryId, body) => postOperatorWrite(promotionsPath(repositoryId), body, decodePromotion(body.candidate_id));
export const postRulesReconcile: RulesReconcileWriter = (repositoryId, body) => postOperatorWrite(`${promotionsPath(repositoryId)}/reconcile`, body, decodePromotion(body.candidate_id));
