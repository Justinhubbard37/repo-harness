import type { BoardItemV1, BoardPullRequestV1, BoardV1 } from '../../core/board/board';
import { BoardSourceError, field, issueClaim, type BoardParentReadV1 } from '../../core/board/source';
import type { RuleOrchestrationV1, RuleStatusV1, RuleTaskV1 } from '../../core/ci/rule-candidates';
import { RULES_PARENT_MARKER } from '../../core/ci/rule-prompt';
import { isRecord } from '../../core/evidence/is-record';
import { BoardCollectError, collectBoard, readGhJson, readParent, type BoardCollectInput } from '../board/collect';
import { promptMarker } from './promote';

interface TaskIssue {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

type TaskReadInput = Omit<BoardCollectInput, 'parent' | 'repository'>;

/** REST lists include bodies; the board's issue projection deliberately does not. */
function issues(input: TaskReadInput, path: string): TaskIssue[] {
  const pages = readGhJson(input, ['api', '--hostname', 'github.com', '--method', 'GET', path, '--paginate', '--slurp']);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new BoardCollectError('invalid issue pages');
  return pages.flat().filter(value => !(isRecord(value) && value.pull_request)).map(value => {
    if (!isRecord(value) || !Number.isSafeInteger(value.number) || (value.number as number) <= 0
      || typeof value.html_url !== 'string' || (value.body !== null && typeof value.body !== 'string')) {
      throw new BoardCollectError('invalid issue');
    }
    return { number: value.number as number, url: value.html_url, body: value.body ?? '' };
  });
}

function unavailable(reason: string): RuleTaskV1 {
  return { issue: null, url: null, route: null, progress: 'unknown', reason, seat: null, pull_request: null };
}

/** A merged PR finishes the task. Otherwise the newest linked PR is the current attempt. */
function taskPullRequest(item: BoardItemV1, board: BoardV1): BoardPullRequestV1 | null {
  const linked = board.pull_requests.filter(pr => item.pull_requests.includes(pr.number)).sort((a, b) => b.number - a.number);
  return linked.find(pr => pr.state === 'merged') ?? linked[0] ?? null;
}

/** Progress consumes board facts only. Acceptance and review_fail are already bound to the head by the board. */
function progress(item: BoardItemV1, pr: BoardPullRequestV1 | null, board: BoardV1): Pick<RuleTaskV1, 'progress' | 'reason'> {
  if (board.tooling.hc.status === 'unavailable') return { progress: 'unknown', reason: board.tooling.hc.reason };
  if (board.execution.status === 'unavailable' && board.execution.reason !== 'no_seat_terminals') {
    return { progress: 'unknown', reason: board.execution.reason };
  }
  if (pr?.state === 'merged') return { progress: 'merged' };
  if (item.pull_requests.some(number => !board.pull_requests.some(pull => pull.number === number))) {
    return { progress: 'unknown', reason: 'pull_request_unavailable' };
  }
  if (item.state === 'closed') return { progress: 'closed_unfinished' };
  if (pr?.state === 'closed' || pr?.review_fail) return { progress: 'pr_rejected' };
  if (pr?.acceptance.status === 'unknown') return { progress: 'unknown', reason: pr.acceptance.reason };
  if (pr?.required_check.status === 'unavailable') return { progress: 'unknown', reason: 'required_checks_unavailable' };
  if (pr?.state === 'open' && !pr.is_draft && pr.required_check.status === 'success' && pr.acceptance.status === 'accepted') {
    return { progress: 'ready_for_go' };
  }
  if (item.claim.status === 'unknown') return { progress: 'unknown', reason: 'claim_unknown' };
  if (item.claim.status === 'active' && (item.claim.role === 'writer' || item.claim.role === 'head owner')) return { progress: 'in_progress' };
  if (pr === null) {
    if (item.claim_status.status_kind === 'unknown') return { progress: 'unknown', reason: 'claim_status_unknown' };
    if (item.claim_status.status_kind === 'observed'
      && (item.claim_status.status === 'done' || item.claim_status.status.startsWith('released'))) return { progress: 'failed' };
  }
  return { progress: 'waiting_orchestration' };
}

function taskSeat(item: BoardItemV1, parent: BoardParentReadV1): string | null {
  if (item.claim.status !== 'active' || (item.claim.role !== 'writer' && item.claim.role !== 'head owner')) return null;
  const claimUrl = item.claim.url;
  const comment = parent.sub_issues.find(issue => issue.number === item.number)?.comments.comments.find(row => row.url === claimUrl);
  // Dispatch writes `Agent: <seat>, session <tab>`. The Seat footer names the poster, not the worker.
  return comment ? field(comment.body, 'Agent')?.split(',')[0]?.trim() || null : null;
}

function attach(status: RuleStatusV1, orchestration: RuleOrchestrationV1, task: (id: string) => RuleTaskV1 | null): RuleStatusV1 {
  return { ...status, orchestration, themes: status.themes.map(theme => ({
    ...theme, actions: theme.actions.map(action => ({ ...action, task: task(action.candidate_id) })),
  })) };
}

/**
 * Opt-in GitHub enrichment. Read errors do not change the ledger or its exit status.
 * The CLI composition root supplies boardHostPorts; this effect never selects a host plugin.
 */
export function collectRulesTasks(status: RuleStatusV1, input: TaskReadInput): RuleStatusV1 {
  const orchestration = { parent: null, plan_comment: false, coordinator_claim: false } as {
    parent: number | null; plan_comment: boolean; coordinator_claim: boolean;
  };
  const repository = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(status.repository_id)?.[1];
  if (!repository) return attach(status, orchestration, () => unavailable('repository_unavailable'));
  let selected: Map<string, { issue: TaskIssue; marker: NonNullable<ReturnType<typeof promptMarker>> }> | null = null;
  try {
    const parents = issues(input, `repos/${repository}/issues?state=open&per_page=100`).filter(issue => issue.body.includes(RULES_PARENT_MARKER));
    if (parents.length > 1) return attach(status, orchestration, () => unavailable('rules_parent_ambiguous'));
    const parent = parents[0];
    if (!parent) return attach(status, orchestration, () => null);
    orchestration.parent = parent.number;
    const children = issues(input, `repos/${repository}/issues/${parent.number}/sub_issues?per_page=100`);
    selected = new Map();
    for (const issue of children) {
      const marker = promptMarker(issue.body);
      if (marker && issue.number > (selected.get(marker.candidate_id)?.issue.number ?? 0)) {
        selected.set(marker.candidate_id, { issue, marker });
      }
    }
    const boardInput = { ...input, repository, parent: parent.number };
    const board = collectBoard(boardInput);
    orchestration.plan_comment = board.plan.status === 'observed';
    // The board omits parent claims and worker names; reuse its source decoder and claim parser.
    const source = readParent(boardInput).parent;
    const coordinator = issueClaim(source.parent.comments);
    orchestration.coordinator_claim = coordinator.status === 'active' && coordinator.role === 'coordinator';
    return attach(status, orchestration, id => {
      const match = selected!.get(id);
      if (!match) return null;
      const item = board.items.find(row => row.number === match.issue.number);
      const pr = item ? taskPullRequest(item, board) : null;
      return {
        issue: match.issue.number, url: match.issue.url, route: match.marker.route,
        ...(item ? progress(item, pr, board) : { progress: 'unknown' as const, reason: 'board_item_unavailable' }),
        seat: item ? taskSeat(item, source) : null,
        pull_request: pr ? { number: pr.number, url: pr.url, head_sha: pr.head_sha, base_sha: pr.base_sha } : null,
      };
    });
  } catch (error) {
    if (!(error instanceof BoardCollectError) && !(error instanceof BoardSourceError)) throw error;
    return attach(status, orchestration, id => {
      if (selected === null) return unavailable('github_read_failed');
      const match = selected.get(id);
      return match ? { ...unavailable('github_read_failed'), issue: match.issue.number, url: match.issue.url, route: match.marker.route } : null;
    });
  }
}
