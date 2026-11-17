/**
 * Decoders for the provider reads behind the board: the parent GraphQL read,
 * the pull request GraphQL read, and the protocol comments in them. Each
 * decoder refuses the first field it cannot read. The collector follows the
 * cursors of the parent's sub-issues and comments to the last page; any other connection
 * that has more pages than one read returns fails closed, because a missing
 * sub-issue, blocked-by edge or pull request would change the board without a
 * trace.
 */

import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isRecord } from '../evidence/is-record';
import { GITHUB_NAME_PATTERN, GITHUB_OWNER_PATTERN } from './github-repository';

import { BoardSourceError, type BoardCommentPageV1 } from './protocol-comments';

export * from './protocol-comments';

export interface BoardRepositoryReadV1 {
  readonly database_id: number;
  readonly name_with_owner: string;
  readonly default_branch: string;
}

export interface BoardIssueReadV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly milestone: string | null;
  readonly comments: BoardCommentPageV1;
}

export interface BoardSubIssueReadV1 extends BoardIssueReadV1 {
  readonly blocked_by: readonly { readonly number: number; readonly state: 'open' | 'closed' }[];
  /** Same-repository pull requests whose timeline cross-references this issue. Their bodies decide the link. */
  readonly pull_request_candidates: readonly number[];
}

export interface BoardParentReadV1 {
  readonly repository: BoardRepositoryReadV1;
  readonly parent: BoardIssueReadV1;
  readonly sub_issues: readonly BoardSubIssueReadV1[];
  /** Open issues whose title matches the CI repair search; the body marker decides. */
  readonly repair_candidates: readonly { readonly number: number; readonly body: string }[];
}

export interface BoardPullRequestReadV1 {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly is_draft: boolean;
  readonly body: string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly head_committed_at: string;
  readonly merged_at: string | null;
  /** Null when the pull request changes more files than one read returns. */
  readonly files: readonly string[] | null;
  /** The added plus deleted lines of `files`, from the same read; null when `files` is null or a file has no count. */
  readonly changed_lines: number | null;
  readonly comments: BoardCommentPageV1;
  readonly readiness_inputs: BoardReadinessInputsV1;
}

/** One check run or commit status of the head commit, as the readiness key and the board required check read it; `status` of a commit status is its state. */
export interface BoardRollupContextV1 {
  readonly type: 'CheckRun' | 'StatusContext';
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly completed_at: string | null;
  readonly details_url: string | null;
  /** The start of a check run; null for a check run that has not started and for a commit status. */
  readonly started_at: string | null;
  /** The workflow name and event of the Actions run of a check run; null for a check run of another app and for a commit status. */
  readonly workflow: { readonly name: string; readonly event: string } | null;
}

/** The fields of the pull request read that merge readiness also reads; the keyed source store digests them. */
export interface BoardReadinessInputsV1 {
  readonly changed_files: number;
  readonly mergeable: string;
  readonly review_decision: string | null;
  readonly cross_repository: boolean;
  /** The states of the latest opinionated reviews; null when the read did not return all of them. */
  readonly review_states: readonly string[] | null;
  /** `isResolved` of each review thread and the thread count; null when the read did not return all threads. */
  readonly threads: { readonly total: number; readonly resolved: readonly boolean[] } | null;
  readonly rollup: readonly BoardRollupContextV1[];
}

/** The most sub-issue pages that one parent read follows: 1000 sub-issues. */
export const BOARD_SUB_ISSUE_PAGES = 20;

/**
 * The most comment pages that one parent read follows: 10,000 comments. The
 * bound stops a runaway cursor; a parent thread above it fails the read closed.
 */
export const BOARD_PARENT_COMMENT_PAGES = 100;

export const BOARD_PAGE = { labels: 50, comments: 50, parent_comments: 100, sub_issues: 50, blocked_by: 50, timeline: 100, files: 100, checks: 100, repairs: 50, reviews: 20, threads: 50 } as const;

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new BoardSourceError(message);
}

function obj(value: unknown, label: string): Json {
  if (!isRecord(value)) fail(`${label} is not an object`);
  return value;
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is not a string`);
  return value;
}

function nullableStr(value: unknown, label: string): string | null {
  return value === null ? null : str(value, label);
}

function int(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is not a positive integer`);
  return value as number;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail(`${label} is not a commit SHA`);
  return value;
}

function time(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} is not a time`);
  return value;
}

function nodes(connection: unknown, label: string, more: 'hasNextPage' | 'hasPreviousPage' | null): unknown[] {
  const value = obj(connection, label);
  if (more !== null && obj(value.pageInfo, `${label}.pageInfo`)[more] !== false) fail(`${label} has more pages than one read returns`);
  if (!Array.isArray(value.nodes)) fail(`${label}.nodes is not an array`);
  return value.nodes;
}

function issueState(value: unknown, label: string): 'open' | 'closed' {
  if (value === 'OPEN') return 'open';
  if (value === 'CLOSED') return 'closed';
  return fail(`${label} is not OPEN or CLOSED`);
}

function comments(connection: unknown, label: string): BoardCommentPageV1 {
  const value = obj(connection, label);
  const truncated = obj(value.pageInfo, `${label}.pageInfo`).hasPreviousPage;
  if (typeof truncated !== 'boolean') fail(`${label}.pageInfo.hasPreviousPage is not a boolean`);
  return Object.freeze({
    truncated,
    comments: Object.freeze(nodes(value, label, null).map((entry, index) => {
      const comment = obj(entry, `${label}[${index}]`);
      return Object.freeze({
        url: str(comment.url, `${label}[${index}].url`),
        created_at: time(comment.createdAt, `${label}[${index}].createdAt`),
        author_association: str(comment.authorAssociation, `${label}[${index}].authorAssociation`),
        body: str(comment.body, `${label}[${index}].body`),
      });
    })),
  });
}

function issue(value: unknown, label: string): BoardIssueReadV1 {
  const node = obj(value, label);
  const milestone = node.milestone === null ? null : str(obj(node.milestone, `${label}.milestone`).title, `${label}.milestone.title`);
  return {
    number: int(node.number, `${label}.number`),
    title: str(node.title, `${label}.title`),
    url: str(node.url, `${label}.url`),
    state: issueState(node.state, `${label}.state`),
    labels: Object.freeze(nodes(node.labels, `${label}.labels`, 'hasNextPage')
      .map((entry, index) => str(obj(entry, `${label}.labels[${index}]`).name, `${label}.labels[${index}].name`))),
    milestone,
    comments: comments(node.comments, `${label}.comments`),
  };
}

function subIssueRead(entry: unknown, label: string, repository: string): BoardSubIssueReadV1 {
  const node = obj(entry, label);
  const candidates = nodes(node.timelineItems, `${label}.timelineItems`, 'hasPreviousPage').flatMap((item) => {
    const source = (item as Json | null)?.source as Json | undefined;
    // A cross-reference from an issue has no PR fields; one from another repository is not ours.
    if (source === undefined || source.number === undefined) return [];
    const sourceRepo = str(obj(source.repository, `${label} source repository`).nameWithOwner, `${label} source repository`);
    return sourceRepo.toLowerCase() === repository.toLowerCase() ? [int(source.number, `${label} source number`)] : [];
  });
  return Object.freeze({
    ...issue(node, label),
    blocked_by: Object.freeze(nodes(node.blockedBy, `${label}.blockedBy`, 'hasNextPage').map((edge, edgeIndex) => {
      const blocker = obj(edge, `${label}.blockedBy[${edgeIndex}]`);
      return Object.freeze({ number: int(blocker.number, `${label}.blockedBy number`), state: issueState(blocker.state, `${label}.blockedBy state`) });
    })),
    pull_request_candidates: Object.freeze([...new Set(candidates)].sort((left, right) => left - right)),
  });
}

function parentSubIssues(data: unknown, at: number): Json {
  return obj(obj(obj(obj(data, `page ${at} data`).repository, `page ${at} repository`).issue, `page ${at} issue`).subIssues, `page ${at} issue.subIssues`);
}

/** The cursor of the next sub-issue page of one parent read, or null on the last page. */
export function parentReadNextCursor(data: unknown, at: number): string | null {
  const info = obj(parentSubIssues(data, at).pageInfo, `page ${at} issue.subIssues.pageInfo`);
  if (info.hasNextPage === false) return null;
  if (info.hasNextPage !== true) fail(`page ${at} issue.subIssues.pageInfo.hasNextPage is not a boolean`);
  if (typeof info.endCursor !== 'string' || info.endCursor === '') fail(`page ${at} issue.subIssues.pageInfo.endCursor is not a cursor`);
  return info.endCursor;
}

function parentComments(data: unknown, at: number): Json {
  return obj(obj(obj(obj(data, `comment page ${at} data`).repository, `comment page ${at} repository`).issue, `comment page ${at} issue`).comments, `comment page ${at} issue.comments`);
}

/** The cursor of the next older comment page of the parent, or null on the oldest page. */
export function parentCommentsPreviousCursor(data: unknown, at: number): string | null {
  const info = obj(parentComments(data, at).pageInfo, `comment page ${at} issue.comments.pageInfo`);
  if (info.hasPreviousPage === false) return null;
  if (info.hasPreviousPage !== true) fail(`comment page ${at} issue.comments.pageInfo.hasPreviousPage is not a boolean`);
  if (typeof info.startCursor !== 'string' || info.startCursor === '') fail(`comment page ${at} issue.comments.pageInfo.startCursor is not a cursor`);
  return info.startCursor;
}

/** The whole comment thread of the parent from its pages, newest page first: oldest comment first, never truncated. */
function parentThread(commentPages: readonly unknown[]): BoardCommentPageV1 {
  const older = commentPages.map((page, at) => {
    if ((parentCommentsPreviousCursor(page, at) !== null) !== (at < commentPages.length - 1)) fail(`comment page ${at} issue.comments.pageInfo.hasPreviousPage does not match the page count`);
    return comments(parentComments(page, at), `comment page ${at} issue.comments`).comments;
  });
  return Object.freeze({ truncated: false, comments: Object.freeze(older.reverse().flat()) });
}

/**
 * The `data` of each sub-issue page of the parent read (`PARENT_QUERY` in the
 * board collector), in cursor order. Every page names the same repository and
 * parent, and only the last page has no next page. The repository, parent and
 * repairs come from the first page. `commentPages` is the first page and then
 * each older page of the parent comments (`PARENT_COMMENTS_QUERY`), in cursor
 * order; only the last one has no previous page.
 */
export function decodeParentRead(pages: readonly unknown[], commentPages: readonly unknown[], repository: string): BoardParentReadV1 {
  if (pages.length === 0) fail('the parent read has no page');
  const root = obj(pages[0], 'data');
  const repo = obj(root.repository, 'repository');
  const nameWithOwner = str(repo.nameWithOwner, 'repository.nameWithOwner');
  if (nameWithOwner.toLowerCase() !== repository.toLowerCase()) fail(`repository is ${nameWithOwner}, expected ${repository}`);
  const parentNode = obj(repo.issue, 'issue');
  const seen = new Set<number>();
  const subIssues = pages.flatMap((page, at) => {
    const pageRepo = obj(obj(page, `page ${at} data`).repository, `page ${at} repository`);
    if (pageRepo.nameWithOwner !== nameWithOwner || obj(pageRepo.issue, `page ${at} issue`).number !== parentNode.number) fail(`page ${at} names another repository or parent`);
    if ((parentReadNextCursor(page, at) !== null) !== (at < pages.length - 1)) fail(`page ${at} issue.subIssues.pageInfo.hasNextPage does not match the page count`);
    return nodes(parentSubIssues(page, at), `page ${at} issue.subIssues`, null).map((entry, index) => {
      const subIssue = subIssueRead(entry, `page ${at} subIssues[${index}]`, repository);
      // A sub-issue list that changed between two page reads can repeat an entry.
      if (seen.has(subIssue.number)) fail(`sub-issue #${subIssue.number} is on more than one page`);
      seen.add(subIssue.number);
      return subIssue;
    });
  });
  const search = obj(root.repairs, 'repairs');
  if (!Number.isSafeInteger(search.issueCount) || (search.issueCount as number) > BOARD_PAGE.repairs) fail('repairs has more results than one read returns');
  return Object.freeze({
    repository: Object.freeze({
      database_id: int(repo.databaseId, 'repository.databaseId'),
      name_with_owner: nameWithOwner,
      default_branch: str(obj(repo.defaultBranchRef, 'repository.defaultBranchRef').name, 'repository.defaultBranchRef.name'),
    }),
    parent: Object.freeze({ ...issue(parentNode, 'issue'), comments: parentThread(commentPages) }),
    sub_issues: Object.freeze(subIssues),
    repair_candidates: Object.freeze(nodes(search, 'repairs', null).map((entry, index) => {
      const node = obj(entry, `repairs[${index}]`);
      return Object.freeze({ number: int(node.number, `repairs[${index}].number`), body: str(node.body, `repairs[${index}].body`) });
    })),
  });
}

function pullRequestState(value: unknown, label: string): BoardPullRequestReadV1['state'] {
  if (value === 'OPEN') return 'open';
  if (value === 'CLOSED') return 'closed';
  if (value === 'MERGED') return 'merged';
  return fail(`${label} is not OPEN, CLOSED or MERGED`);
}

/** `data` of the pull request read: one `pr<number>` alias per requested number. */
export function decodePullRequestsRead(data: unknown, numbers: readonly number[]): BoardPullRequestReadV1[] {
  const repo = obj(obj(data, 'data').repository, 'repository');
  return numbers.map((number) => {
    const label = `pr${number}`;
    const node = obj(repo[label], label);
    if (node.number !== number) fail(`${label}.number is not ${number}`);
    const commit = obj(obj(nodes(node.commits, `${label}.commits`, null)[0], `${label}.commits[0]`).commit, `${label} head commit`);
    const headSha = sha(node.headRefOid, `${label}.headRefOid`);
    if (commit.oid !== headSha) fail(`${label} last commit is not the head`);
    const files = obj(node.files, `${label}.files`);
    const fileNodes = nodes(files, `${label}.files`, null).map((entry, index) => obj(entry, `${label}.files[${index}]`));
    const filePaths = fileNodes.map((node, index) => str(node.path, `${label}.files[${index}].path`));
    const complete = files.totalCount === filePaths.length;
    const counted = complete && fileNodes.every(node => [node.additions, node.deletions].every(count => Number.isSafeInteger(count) && (count as number) >= 0));
    const rollup = commit.statusCheckRollup === null ? [] : rollupContexts(obj(commit.statusCheckRollup, `${label}.statusCheckRollup`), label);
    return Object.freeze({
      number,
      url: str(node.url, `${label}.url`),
      state: pullRequestState(node.state, `${label}.state`),
      is_draft: node.isDraft === true,
      body: str(node.body, `${label}.body`),
      base_ref: str(node.baseRefName, `${label}.baseRefName`),
      base_sha: sha(node.baseRefOid, `${label}.baseRefOid`),
      head_ref: str(node.headRefName, `${label}.headRefName`),
      head_sha: headSha,
      head_committed_at: time(commit.committedDate, `${label} head committedDate`),
      merged_at: node.mergedAt === null ? null : time(node.mergedAt, `${label}.mergedAt`),
      files: complete ? Object.freeze(filePaths) : null,
      changed_lines: counted ? fileNodes.reduce((sum, node) => sum + (node.additions as number) + (node.deletions as number), 0) : null,
      comments: comments(node.comments, `${label}.comments`),
      readiness_inputs: readinessInputs(node, rollup, label),
    });
  });
}

function rollupContexts(rollup: Json, label: string): BoardRollupContextV1[] {
  return nodes(rollup.contexts, `${label}.contexts`, 'hasNextPage').map((entry, index) => {
    const context = obj(entry, `${label}.contexts[${index}]`);
    const at = `${label}.contexts[${index}]`;
    if (context.name !== undefined) {
      return Object.freeze({
        type: 'CheckRun', name: str(context.name, `${at}.name`), status: str(context.status, `${at}.status`),
        conclusion: nullableStr(context.conclusion, `${at}.conclusion`),
        completed_at: context.completedAt === null ? null : time(context.completedAt, `${at}.completedAt`),
        details_url: nullableStr(context.detailsUrl, `${at}.detailsUrl`),
        started_at: context.startedAt === null ? null : time(context.startedAt, `${at}.startedAt`),
        workflow: workflowOf(obj(context.checkSuite, `${at}.checkSuite`).workflowRun, `${at}.checkSuite.workflowRun`),
      } as const);
    }
    if (context.context !== undefined) {
      return Object.freeze({
        type: 'StatusContext', name: str(context.context, `${at}.context`), status: str(context.state, `${at}.state`), conclusion: null,
        completed_at: time(context.createdAt, `${at}.createdAt`), details_url: nullableStr(context.targetUrl, `${at}.targetUrl`),
        started_at: null, workflow: null,
      } as const);
    }
    return fail(`${at} is neither a check run nor a commit status`);
  });
}

function workflowOf(value: unknown, label: string): BoardRollupContextV1['workflow'] {
  if (value === null) return null;
  const run = obj(value, label);
  return Object.freeze({ name: str(obj(run.workflow, `${label}.workflow`).name, `${label}.workflow.name`), event: str(run.event, `${label}.event`) });
}

function complete(connection: unknown, label: string): unknown[] | null {
  const value = obj(connection, label);
  const more = obj(value.pageInfo, `${label}.pageInfo`).hasNextPage;
  if (typeof more !== 'boolean') fail(`${label}.pageInfo.hasNextPage is not a boolean`);
  return more ? null : nodes(value, label, null);
}

function readinessInputs(node: Json, rollup: readonly BoardRollupContextV1[], label: string): BoardReadinessInputsV1 {
  if (!Number.isSafeInteger(node.changedFiles) || (node.changedFiles as number) < 0) fail(`${label}.changedFiles is not a count`);
  if (typeof node.isCrossRepository !== 'boolean') fail(`${label}.isCrossRepository is not a boolean`);
  const reviews = complete(node.latestOpinionatedReviews, `${label}.latestOpinionatedReviews`);
  const threads = obj(node.reviewThreads, `${label}.reviewThreads`);
  const threadNodes = complete(threads, `${label}.reviewThreads`);
  if (!Number.isSafeInteger(threads.totalCount) || (threads.totalCount as number) < 0) fail(`${label}.reviewThreads.totalCount is not a count`);
  return Object.freeze({
    changed_files: node.changedFiles as number,
    mergeable: str(node.mergeable, `${label}.mergeable`),
    review_decision: nullableStr(node.reviewDecision, `${label}.reviewDecision`),
    cross_repository: node.isCrossRepository,
    review_states: reviews === null ? null : Object.freeze(reviews.map((entry, index) => str(obj(entry, `${label}.latestOpinionatedReviews[${index}]`).state, `${label}.latestOpinionatedReviews[${index}].state`))),
    threads: threadNodes === null ? null : Object.freeze({
      total: threads.totalCount as number,
      resolved: Object.freeze(threadNodes.map((entry, index) => {
        const resolved = obj(entry, `${label}.reviewThreads[${index}]`).isResolved;
        if (typeof resolved !== 'boolean') fail(`${label}.reviewThreads[${index}].isResolved is not a boolean`);
        return resolved;
      })),
    }),
    rollup: Object.freeze([...rollup]),
  });
}

/** One open issue of the parent list read, with its sub-issue counts. */
export interface BoardOpenIssueReadV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly updated_at: string;
  readonly sub_issues: { readonly total: number; readonly completed: number };
}

export interface BoardOpenIssuesReadV1 {
  readonly repository: { readonly database_id: number; readonly name_with_owner: string };
  readonly issues: readonly BoardOpenIssueReadV1[];
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is not a count`);
  return value as number;
}

/**
 * The pages of `gh api graphql --paginate --slurp` for the parent list read
 * (`OPEN_ISSUES_QUERY` in the parent list collector). Every page names the
 * same repository, and the last page has no next page.
 */
export function decodeOpenIssuesRead(pages: unknown): BoardOpenIssuesReadV1 {
  if (!Array.isArray(pages) || pages.length === 0) fail('the open issue read has no page');
  let repository: BoardOpenIssuesReadV1['repository'] | null = null;
  const issues = pages.flatMap((page, at) => {
    const repo = obj(obj(obj(page, `page ${at}`).data, `page ${at} data`).repository, `page ${at} repository`);
    const current = { database_id: int(repo.databaseId, 'repository.databaseId'), name_with_owner: str(repo.nameWithOwner, 'repository.nameWithOwner') };
    if (repository !== null && (repository.database_id !== current.database_id || repository.name_with_owner !== current.name_with_owner)) fail(`page ${at} names another repository`);
    repository = current;
    const connection = obj(repo.issues, `page ${at} issues`);
    const next = obj(connection.pageInfo, `page ${at} issues.pageInfo`).hasNextPage;
    if (next !== (at < pages.length - 1)) fail(`page ${at} issues.pageInfo.hasNextPage does not match the page count`);
    return nodes(connection, `page ${at} issues`, null).map((entry, index) => {
      const label = `page ${at} issues[${index}]`;
      const node = obj(entry, label);
      const summary = obj(node.subIssuesSummary, `${label}.subIssuesSummary`);
      return Object.freeze({
        number: int(node.number, `${label}.number`),
        title: str(node.title, `${label}.title`),
        url: str(node.url, `${label}.url`),
        updated_at: time(node.updatedAt, `${label}.updatedAt`),
        sub_issues: Object.freeze({ total: count(summary.total, `${label}.subIssuesSummary.total`), completed: count(summary.completed, `${label}.subIssuesSummary.completed`) }),
      });
    });
  });
  return Object.freeze({ repository: Object.freeze(repository!), issues: Object.freeze(issues) });
}

const REFS = /(?<![A-Za-z0-9_])refs?\s*:?\s*#([1-9][0-9]*)/giu;

/** Text within one Markdown block; NUL barriers prevent matches across excluded content. */
function inlineRefsText(node: Nodes): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'break') return '\n';
  if (node.type === 'html') return node.value.replace(/<!--[\s\S]*?(?:-->|$)/gu, '\0');
  if (node.type === 'inlineCode') return '\0';
  return 'children' in node ? node.children.map(inlineRefsText).join('') : '\0';
}

/** Issue numbers outside code blocks, HTML comments and quotes. Closing keywords are `parseClosingReferences`. */
export function parseRefs(body: string): number[] {
  const refs = new Set<number>();
  function visit(node: Nodes): void {
    if (node.type === 'code' || node.type === 'blockquote') return;
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell' || node.type === 'html') {
      for (const match of inlineRefsText(node).matchAll(REFS)) refs.add(Number(match[1]));
    } else if ('children' in node) {
      node.children.forEach(visit);
    }
  }
  visit(fromMarkdown(body));
  return [...refs].sort((left, right) => left - right);
}

const GITHUB_REMOTE = new RegExp(
  `^(?:https://(?:[^@/]+@)?github\\.com/|git@github\\.com:|ssh://git@github\\.com(?::22)?/)(${GITHUB_OWNER_PATTERN})/(${GITHUB_NAME_PATTERN}?)(?:\\.git)?/?$`,
  'iu',
);

/** `owner/name` of a GitHub remote URL (https, scp-like ssh or ssh://), lowercased; null for any other URL. */
export function githubRemoteRepository(url: string): string | null {
  const match = GITHUB_REMOTE.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
