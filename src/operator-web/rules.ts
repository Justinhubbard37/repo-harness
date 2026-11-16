import { useCallback, useState } from 'react';
import {
  decodeRulesSnapshot,
  RULES_UNAVAILABLE_REASONS,
  type RulesSnapshotV1,
  type RulesUnavailableReason,
} from '../core/operator/rules';
import { readJson } from './json-read';
import { asApiError, type OperatorApiErrorV1 } from './operator-api-error';
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
