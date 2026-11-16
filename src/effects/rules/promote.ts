import { ROUTING_CLASSES, type RoutingClass } from '../../core/board/seats-settings';
import type { RuleStatusV1 } from '../../core/ci/rule-candidates';
import {
  RULES_PARENT_BODY, RULES_PARENT_MARKER, RULES_PROMOTE_KIND, RulesPromoteError,
  promotionCandidate, promotionTitle, renderPromotionPrompt,
} from '../../core/ci/rule-prompt';
import { isRecord } from '../../core/evidence/is-record';
import { sha256Hex } from '../../core/evidence/sha256';
import { GithubAdapterError, runGithubCommand, type GithubCommandRunner } from '../github/issues';

export interface RulesPromoteResult {
  readonly kind: typeof RULES_PROMOTE_KIND;
  readonly protocol: 1;
  readonly candidate_id: string;
  readonly parent: number;
  readonly issue: number;
  readonly url: string;
  readonly prompt_sha256: string;
  readonly steps: {
    readonly issue: 'created' | 'found';
    readonly label: 'added' | 'present';
    readonly sub_issue: 'linked' | 'present';
  };
}

export function promotionRoute(value: string): RoutingClass {
  if (!ROUTING_CLASSES.includes(value as RoutingClass)) throw new RulesPromoteError('route_invalid');
  return value as RoutingClass;
}

/** A final newline is allowed. The body itself is never trimmed or rewritten. */
export function promptMarker(body: string): { candidate_id: string; route: RoutingClass } | null {
  const lastLine = body.replace(/\r?\n$/u, '').split(/\r?\n/u).at(-1) ?? '';
  const match = /^<!-- repo-harness\.rules\.candidate:([a-f0-9]{64}) route:([a-z_]+) -->$/u.exec(lastLine);
  if (!match || !ROUTING_CLASSES.includes(match[2] as RoutingClass)) return null;
  return { candidate_id: match[1]!, route: match[2] as RoutingClass };
}

function validatePromotionPrompt(body: string, candidateId: string, route: RoutingClass): void {
  const marker = promptMarker(body);
  if (marker?.candidate_id !== candidateId || marker.route !== route) throw new RulesPromoteError('prompt_marker_missing');
}

interface Issue {
  readonly id: number;
  readonly number: number;
  readonly html_url: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly parent_issue_url: string | null;
}

function decodeIssue(value: unknown): Issue {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0
    || !Number.isSafeInteger(value.number) || (value.number as number) <= 0
    || typeof value.html_url !== 'string' || (value.body !== null && typeof value.body !== 'string')
    || (value.state !== 'open' && value.state !== 'closed') || !Array.isArray(value.labels)
    || (value.parent_issue_url != null && typeof value.parent_issue_url !== 'string')) {
    throw new RulesPromoteError('github_invalid_response');
  }
  const labels = value.labels.map(label => {
    if (!isRecord(label) || typeof label.name !== 'string') throw new RulesPromoteError('github_invalid_response');
    return label.name;
  });
  return { id: value.id as number, number: value.number as number, html_url: value.html_url,
    body: value.body ?? '', state: value.state, labels, parent_issue_url: value.parent_issue_url ?? null };
}

/** All requests use the status document's repository, never gh's working directory. */
class PromotionGithub {
  private readonly path: string;

  constructor(repositoryId: string, private readonly runner: GithubCommandRunner) {
    const repository = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(repositoryId)?.[1];
    if (!repository) throw new RulesPromoteError('repository_unavailable');
    this.path = `repos/${repository}/issues`;
  }

  private api(method: 'GET' | 'POST', path: string, args: readonly string[] = []): string {
    try {
      return this.runner(['api', '--hostname', 'github.com', '--method', method, path, ...args],
        { timeout_ms: 30_000, max_buffer: 64 * 1024 * 1024 }).stdout;
    } catch (error) {
      if (error instanceof GithubAdapterError) throw new RulesPromoteError(`github_${error.failure_class}`);
      throw error;
    }
  }

  private read<T>(path: string, decode: (value: unknown) => T, args: readonly string[] = [], method: 'GET' | 'POST' = 'GET'): T {
    const stdout = this.api(method, path, args);
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); }
    catch { throw new RulesPromoteError('github_invalid_response'); }
    return decode(parsed);
  }

  private list(path: string, args: readonly string[] = []): Issue[] {
    return this.read(path, pages => {
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new RulesPromoteError('github_invalid_response');
      return pages.flat().filter(value => !(isRecord(value) && value.pull_request)).map(decodeIssue);
    }, ['--paginate', '--slurp', '-f', 'per_page=100', ...args]);
  }

  issues(state: 'open' | 'all'): Issue[] {
    return this.list(this.path, ['-f', `state=${state}`]);
  }

  children(parent: number): Issue[] {
    return this.list(`${this.path}/${parent}/sub_issues`);
  }

  existingParent(issue: Issue): Issue | null {
    return issue.parent_issue_url ? this.read(`${this.path}/${issue.number}/parent`, decodeIssue) : null;
  }

  parent(issues: readonly Issue[]): Issue {
    const parents = issues.filter(issue => issue.state === 'open' && issue.body.includes(RULES_PARENT_MARKER));
    if (parents.length > 1) throw new RulesPromoteError('rules_parent_ambiguous');
    return parents[0] ?? this.create('Batch: rules promotion', RULES_PARENT_BODY);
  }

  create(title: string, body: string): Issue {
    return this.read(this.path, decodeIssue, ['-f', `title=${title}`, '-f', `body=${body}`], 'POST');
  }

  complete(issue: Issue, parent: Issue, candidateId: string, route: RoutingClass, step: 'created' | 'found'): RulesPromoteResult {
    const current = this.read(`${this.path}/${issue.number}`, decodeIssue);
    const label = `route:${route}`;
    const labelPresent = current.labels.includes(label);
    if (!labelPresent) this.api('POST', `${this.path}/${issue.number}/labels`, ['-f', `labels[]=${label}`]);
    const linked = this.children(parent.number).some(child => child.id === issue.id);
    if (!linked) this.api('POST', `${this.path}/${parent.number}/sub_issues`, ['-F', `sub_issue_id=${issue.id}`]);
    return {
      kind: RULES_PROMOTE_KIND, protocol: 1, candidate_id: candidateId,
      parent: parent.number, issue: issue.number, url: issue.html_url, prompt_sha256: sha256Hex(issue.body),
      steps: { issue: step, label: labelPresent ? 'present' : 'added', sub_issue: linked ? 'present' : 'linked' },
    };
  }
}

export function promoteRules(input: {
  readonly status: RuleStatusV1;
  readonly candidate_id: string;
  readonly route: RoutingClass;
  readonly ledger_blob: string;
  readonly prompt?: string;
}, runner: GithubCommandRunner = runGithubCommand): RulesPromoteResult {
  const candidate = promotionCandidate(input.status, input.candidate_id, input.ledger_blob);
  const route = promotionRoute(input.route);
  const prompt = input.prompt ?? renderPromotionPrompt(candidate, route);
  validatePromotionPrompt(prompt, input.candidate_id, route);
  const github = new PromotionGithub(input.status.repository_id, runner);
  const open = github.issues('open');
  // Check the parent's paged children directly: GitHub search does not index HTML comments.
  const parents = open.filter(issue => issue.body.includes(RULES_PARENT_MARKER));
  if (parents.length > 1) throw new RulesPromoteError('rules_parent_ambiguous');
  const children = parents[0] ? github.children(parents[0].number) : [];
  // The repository list also catches a prior create whose sub-issue link failed.
  const duplicate = [...children, ...open].find(issue => issue.state === 'open' && promptMarker(issue.body)?.candidate_id === input.candidate_id);
  if (duplicate) throw new RulesPromoteError('candidate_open', duplicate.number);
  const parent = github.parent(open);
  const issue = github.create(promotionTitle(candidate), prompt);
  return github.complete(issue, parent, input.candidate_id, route, 'created');
}

/** Recovery uses the filed marker, even after the lesson ceases to be a candidate. */
export function reconcileRules(input: {
  readonly repository_id: string;
  readonly candidate_id: string;
}, runner: GithubCommandRunner = runGithubCommand): RulesPromoteResult {
  const github = new PromotionGithub(input.repository_id, runner);
  const issues = github.issues('all');
  const matches = issues.filter(issue => promptMarker(issue.body)?.candidate_id === input.candidate_id);
  const open = matches.filter(issue => issue.state === 'open');
  const selected = open.length > 0 ? open : matches;
  if (selected.length === 0) throw new RulesPromoteError('candidate_not_filed');
  if (selected.length > 1) throw new RulesPromoteError('candidate_ambiguous');
  const issue = selected[0]!;
  const marker = promptMarker(issue.body)!;
  const parent = github.existingParent(issue) ?? github.parent(issues);
  return github.complete(issue, parent, input.candidate_id, marker.route, 'found');
}
