import {
  checkPlanSupersedes, checkPostBody, decodePostFields, renderPostBody, type BoardPostFieldsV1,
} from '../../core/board/post';
import { withSeatLine } from '../../core/board/seat-line';
import type { BoardCommentPageV1 } from '../../core/board/source';
import { BoardCollectError, runGhText } from './collect';

/** The writes and reads of one post. Each is a process boundary, so the command and its tests take them in. */
export interface BoardPostPorts {
  /** Every comment of the target thread; the `Supersedes:` rule reads it. */
  readonly comments: (target: number) => BoardCommentPageV1;
  /** Whether the target number is a pull request; an acceptance disposition goes on a pull request only. */
  readonly is_pull_request: (target: number) => boolean;
  /** Posts an issue or pull request comment and returns its URL. */
  readonly comment: (target: number, body: string) => string;
}

export interface BoardPostInput {
  readonly target: number;
  /** One of `BOARD_POST_KINDS`. */
  readonly kind: string;
  /** The JSON object of `--fields-file`. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Render and check only: no comment is posted. */
  readonly dry_run: boolean;
}

export interface BoardPostResultV1 {
  readonly kind: string;
  /** The exact text that the parser checked; posted unless this was a dry run. */
  readonly body: string;
  /** The comment URL; null on a dry run. */
  readonly url: string | null;
}

/** A kind that only one thread shape takes: `disposition` names a FAIL acceptance record of a pull request. */
const PR_ONLY: ReadonlySet<string> = new Set(['disposition']);

/** Every comment of one issue or pull request in this repository: `--paginate` reads the whole thread. */
function readComments(repo_root: string, target: number): BoardCommentPageV1 {
  const printed = runGhText({ repo_root }, ['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${target}/comments?per_page=100`]);
  let pages: { html_url: string; created_at: string; author_association: string; body: string }[][];
  try {
    pages = JSON.parse(printed) as typeof pages;
  } catch {
    throw new BoardCollectError(`gh api printed no comment page list for #${target}`);
  }
  return { truncated: false, comments: pages.flat().map(({ html_url, created_at, author_association, body }) => ({ url: html_url, created_at, author_association, body })) };
}

/** Whether the target is a pull request; `gh pr view` fails with exit 1 for an issue that has no pull request. */
function isPullRequest(repo_root: string, target: number): boolean {
  try {
    runGhText({ repo_root }, ['pr', 'view', String(target), '--json', 'number']);
    return true;
  } catch (error) {
    if (!(error instanceof BoardCollectError)) throw error;
    return false;
  }
}

/** The ports of a real run: `gh api` reads the thread, `gh issue comment` posts to an issue or a pull request alike. */
export function gitHubPostPorts(repo_root: string): BoardPostPorts {
  return {
    comments: target => readComments(repo_root, target),
    is_pull_request: target => isPullRequest(repo_root, target),
    comment: (target, body) => runGhText({ repo_root }, ['issue', 'comment', String(target), '--body-file', '-'], body),
  };
}

/**
 * Validate the fields, render the one comment of the kind, add the seat trace line, decode the posted text with the kind's own parser,
 * then post it to `--target`. A refused field, a plan without `Supersedes:` on a thread that already holds a plan, and text that the
 * parser does not read back identically each throw before the post, so no write happens. `--dry-run` returns the checked text instead.
 */
export function runBoardPost(input: BoardPostInput, ports: BoardPostPorts, env: NodeJS.ProcessEnv = process.env): BoardPostResultV1 {
  const post: BoardPostFieldsV1 = decodePostFields(input.kind, input.fields);
  if (PR_ONLY.has(post.kind) && !ports.is_pull_request(input.target)) {
    throw new BoardCollectError(`board post ${post.kind}: #${input.target} is not a pull request; an acceptance disposition goes on a pull request`);
  }
  if (post.kind === 'plan') checkPlanSupersedes(post.fields, ports.comments(input.target));
  // The same `Seat:` trace that `board dispatch` writes. The parser checks the posted text, not a variant of it.
  const body = withSeatLine(renderPostBody(post), env);
  checkPostBody(post, body);
  if (input.dry_run) return { kind: post.kind, body, url: null };
  return { kind: post.kind, body, url: ports.comment(input.target, body) };
}
