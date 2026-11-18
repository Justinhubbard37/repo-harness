/** GitHub GraphQL provider observation and untrusted display text for manual feedback. */
import { spawnSync } from 'child_process';

import { MergeReadinessError, observeProviderReadinessIdentity } from '../publication/merge-readiness';
import type { PullRequestSelectionV2 } from '../../core/publication/merge-readiness';
import { buildFeedbackEvent, type FeedbackCheckConclusion, type FeedbackEventV1, type FeedbackMergeability } from '../../core/publication/feedback';
import { type TaskMessageClaim } from '../../core/messages/task-message-claim';

export type FeedbackErrorCode =
  | 'feedback_provider_failed'
  | 'feedback_provider_incomplete'
  | 'feedback_provider_shape_invalid'
  | 'feedback_event_id_missing'
  | 'feedback_incomplete'
  | 'feedback_unreadable'
  | 'provider_event_conflict'
  | 'reaction_receipt_conflict'
  | 'publication_not_found'
  | 'publication_claim_mismatch'
  | 'head_moved'
  | 'feedback_revision_mismatch'
  | 'repair_offer_stale'
  | 'repair_not_dispatched'
  | 'repair_completion_unverified'
  | 'repair_completion_not_distinct'
  | 'no_progress';

export class FeedbackError extends Error {
  constructor(readonly code: FeedbackErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'FeedbackError';
  }
}

export interface GhRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly error?: Error;
}

export interface FeedbackObservationInput {
  readonly repo_root: string;
  readonly gh_bin?: string;
  /** Test seam. Production invokes the configured gh binary. */
  readonly gh_runner?: (args: readonly string[]) => GhRunResult;
}

export interface ProviderIdentity {
  readonly provider_repo_id: string;
  readonly pr_number: number;
  readonly provider_url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly is_draft: boolean;
  readonly head_sha: string;
  readonly head_ref: string;
  readonly base_sha: string;
  readonly base_ref: string;
  readonly mergeability: FeedbackMergeability;
}

/** Explicit observed provider subject. This is not a publication receipt or authority. */
export interface FeedbackSubject {
  readonly publication_id: string;
  readonly selection: PullRequestSelectionV2;
  readonly task_id: string;
  readonly repository_id: string;
  readonly issue_id: string;
  readonly campaign_id: string;
  readonly claim: TaskMessageClaim;
  readonly admission_sha256: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly pr_number: number;
}

export class TornReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TornReadError';
  }
}

const CHECK_SUITE_QUERY = [
  'query($repoId:ID!,$number:Int!,$after:String){',
  'node(id:$repoId){... on Repository{pullRequest(number:$number){commits(last:1){nodes{commit{oid checkSuites(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id}}}}}}}}}',
].join('');

const CHECK_RUN_QUERY = [
  'query($suiteId:ID!,$after:String){',
  'node(id:$suiteId){... on CheckSuite{checkRuns(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id status conclusion completedAt}}}}}',
].join('');

const REVIEW_THREAD_QUERY = [
  'query($repoId:ID!,$number:Int!,$after:String){',
  'node(id:$repoId){... on Repository{pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved updatedAt}}}}}}',
].join('');

const REVIEW_QUERY = [
  'query($repoId:ID!,$number:Int!,$after:String){',
  'node(id:$repoId){... on Repository{pullRequest(number:$number){reviews(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id state submittedAt}}}}}}',
].join('');

const SHOW_CHECK_RUN_QUERY = [
  'query($id:ID!){',
  'node(id:$id){... on CheckRun{id name detailsUrl status conclusion output{title summary text}}}',
  '}',
].join('');

const SHOW_REVIEW_THREAD_QUERY = [
  'query($id:ID!,$after:String){',
  'node(id:$id){... on PullRequestReviewThread{id isResolved comments(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id body url}}}}',
  '}',
].join('');

const SHOW_REVIEW_QUERY = [
  'query($id:ID!){',
  'node(id:$id){... on PullRequestReview{id state body url submittedAt}}',
  '}',
].join('');

/** A provider connection must converge within a bounded, non-cyclic read. */
const MAX_PROVIDER_PAGES = 100;
const CHECK_RUN_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']);
const CHECK_RUN_CONCLUSIONS = new Set([
  'ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'NEUTRAL', 'SKIPPED',
  'STALE', 'STARTUP_FAILURE', 'SUCCESS', 'TIMED_OUT',
]);

function providerFailure(message: string, cause?: unknown): FeedbackError {
  return new FeedbackError('feedback_provider_failed', message, cause);
}

function providerIncomplete(message: string, cause?: unknown): FeedbackError {
  return new FeedbackError('feedback_provider_incomplete', message, cause);
}

function providerShape(message: string, cause?: unknown): FeedbackError {
  return new FeedbackError('feedback_provider_shape_invalid', message, cause);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerShape(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, id = false): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FeedbackError(id ? 'feedback_event_id_missing' : 'feedback_provider_shape_invalid', `${label} is required`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw providerShape(`${label} must be a boolean`);
  return value;
}

function ghJson(input: FeedbackObservationInput, args: readonly string[]): unknown {
  // Feedback identities and their GraphQL objects belong to the same public provider.
  args = [...args, '--hostname', 'github.com'];
  const result = input.gh_runner?.(args) ?? spawnSync(input.gh_bin ?? process.env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
    cwd: input.repo_root,
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) {
    throw providerFailure(
      `provider observation failed: gh ${args.join(' ')}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`,
      result.error,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw providerIncomplete(`provider returned invalid JSON: gh ${args.join(' ')}`, error);
  }
}

function identityBytes(identity: ProviderIdentity): string {
  return JSON.stringify(identity);
}

export function observeIdentity(receipt: FeedbackSubject, input: FeedbackObservationInput): ProviderIdentity {
  let selected: ReturnType<typeof observeProviderReadinessIdentity>;
  try { selected = observeProviderReadinessIdentity({ ...receipt.selection, repo_root: input.repo_root,
    gh_bin: input.gh_bin, gh_runner: input.gh_runner ? args => {
      const result = input.gh_runner!(args);
      if (result.error || result.status === null) throw providerFailure('provider identity observation failed', result.error);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } : undefined });
  } catch (error) {
    if (!(error instanceof MergeReadinessError)) throw error;
    if (error.code === 'provider_unavailable') throw providerFailure(error.message, error);
    throw providerShape(error.message);
  }
  if (selected.state !== 'OPEN' && selected.state !== 'CLOSED' && selected.state !== 'MERGED') throw providerShape('provider PR state is unknown');
  const identity: ProviderIdentity = Object.freeze({ provider_repo_id: selected.provider_repo_id,
    pr_number: selected.pr_number, provider_url: selected.pr_url, state: selected.state, is_draft: selected.is_draft,
    head_sha: selected.head_sha, head_ref: selected.head_ref, base_sha: selected.base_sha, base_ref: selected.base_ref,
    mergeability: requiredMergeability(selected.mergeable) });
  return identity;
}

function requiredMergeability(value: unknown): FeedbackMergeability {
  if (value !== 'MERGEABLE' && value !== 'CONFLICTING') {
    throw providerShape('provider PR mergeStateStatus is unknown or unavailable');
  }
  return value;
}

export function assertStableIdentity(identity: ProviderIdentity, receipt: FeedbackSubject): void {
  if (identity.head_sha !== receipt.head_sha) {
    throw new FeedbackError('head_moved', 'provider PR head does not match the publication receipt');
  }
  if (identity.base_sha !== receipt.base_sha) {
    throw new FeedbackError('publication_claim_mismatch', 'provider PR base does not match the publication receipt');
  }
  if (identity.state !== 'OPEN' || identity.is_draft) {
    throw providerShape('provider PR is not an open non-draft publication');
  }
}

function graphValue(
  input: FeedbackObservationInput,
  query: string,
  scalars: readonly [string, string][],
  after: string | null,
): Record<string, unknown> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of scalars) args.push('-F', `${name}=${value}`);
  if (after !== null) args.push('-F', `after=${after}`);
  const graph = asObject(ghJson(input, args), 'provider GraphQL result');
  if (Object.hasOwn(graph, 'errors')) {
    if (!Array.isArray(graph.errors)) throw providerShape('provider GraphQL errors must be an array');
    if (graph.errors.length > 0) throw providerIncomplete('provider GraphQL response contains errors');
  }
  return graph;
}

function page(value: unknown, label: string): { readonly has_next_page: boolean; readonly end_cursor: string | null; readonly nodes: readonly unknown[] } {
  const connection = asObject(value, label);
  const info = asObject(connection.pageInfo, `${label}.pageInfo`);
  const hasNextPage = requiredBoolean(info.hasNextPage, `${label}.pageInfo.hasNextPage`);
  const endCursor = info.endCursor;
  if (endCursor !== null && (typeof endCursor !== 'string' || endCursor.length === 0)) {
    throw providerShape(`${label}.pageInfo.endCursor is invalid`);
  }
  if (hasNextPage && endCursor === null) throw providerIncomplete(`${label} pagination is incomplete`);
  if (!Array.isArray(connection.nodes)) throw providerShape(`${label}.nodes must be an array`);
  return Object.freeze({ has_next_page: hasNextPage, end_cursor: endCursor as string | null, nodes: connection.nodes });
}

function nextPageCursor(
  value: ReturnType<typeof page>,
  label: string,
  seenCursors: Set<string>,
): string | null {
  if (!value.has_next_page) return null;
  const cursor = value.end_cursor;
  if (cursor === null) throw providerIncomplete(`${label} pagination is incomplete`);
  if (seenCursors.has(cursor)) throw providerIncomplete(`${label} pagination cursor repeated`);
  seenCursors.add(cursor);
  return cursor;
}

function checkRunState(run: Record<string, unknown>): { readonly status: string; readonly conclusion: string | null } {
  const status = requiredString(run.status, 'provider check run status');
  if (!CHECK_RUN_STATUSES.has(status)) throw providerShape(`provider check run status is unknown: ${status}`);
  const conclusion = run.conclusion;
  if (conclusion !== null && typeof conclusion !== 'string') throw providerShape('provider check run conclusion is invalid');
  if (typeof conclusion === 'string' && !CHECK_RUN_CONCLUSIONS.has(conclusion)) {
    throw providerShape(`provider check run conclusion is unknown: ${conclusion}`);
  }
  if (status === 'COMPLETED' && conclusion === null) {
    throw providerShape('completed provider check run has no conclusion');
  }
  if (status !== 'COMPLETED' && conclusion !== null) {
    throw providerShape('incomplete provider check run has a conclusion');
  }
  return Object.freeze({ status, conclusion });
}

function checkSuiteIds(identity: ProviderIdentity, receipt: FeedbackSubject, input: FeedbackObservationInput): readonly string[] {
  const ids: string[] = [];
  let after: string | null = null;
  let pageCount = 0;
  const seenCursors = new Set<string>();
  do {
    if (pageCount >= MAX_PROVIDER_PAGES) throw providerIncomplete(`provider check suites pagination exceeds ${MAX_PROVIDER_PAGES} pages`);
    pageCount += 1;
    const graph = graphValue(input, CHECK_SUITE_QUERY, [['repoId', identity.provider_repo_id], ['number', String(receipt.pr_number)]], after);
    const data = asObject(graph.data, 'provider GraphQL data');
    const repository = asObject(data.node, 'provider repository node');
    const pr = asObject(repository.pullRequest, 'provider pull request node');
    const commits = asObject(pr.commits, 'provider PR commits');
    const commitNodes = commits.nodes;
    if (!Array.isArray(commitNodes) || commitNodes.length !== 1) throw providerIncomplete('provider PR head commit observation is incomplete');
    const commit = asObject(asObject(commitNodes[0], 'provider PR commit node').commit, 'provider check commit');
    if (requiredString(commit.oid, 'provider check commit OID') !== receipt.head_sha) throw new TornReadError('provider check observation moved to a different head');
    const suites = page(commit.checkSuites, 'provider check suites');
    for (const entry of suites.nodes) ids.push(requiredString(asObject(entry, 'provider check suite').id, 'provider check suite id', true));
    after = nextPageCursor(suites, 'provider check suites', seenCursors);
  } while (after !== null);
  return ids;
}

function failedCheckEvents(identity: ProviderIdentity, receipt: FeedbackSubject, input: FeedbackObservationInput): readonly FeedbackEventV1[] {
  const events: FeedbackEventV1[] = [];
  for (const suiteId of checkSuiteIds(identity, receipt, input)) {
    let after: string | null = null;
    let pageCount = 0;
    const seenCursors = new Set<string>();
    do {
      if (pageCount >= MAX_PROVIDER_PAGES) throw providerIncomplete(`provider check runs pagination exceeds ${MAX_PROVIDER_PAGES} pages`);
      pageCount += 1;
      const graph = graphValue(input, CHECK_RUN_QUERY, [['suiteId', suiteId]], after);
      const data = asObject(graph.data, 'provider GraphQL data');
      const suite = asObject(data.node, 'provider check suite node');
      const runs = page(suite.checkRuns, 'provider check runs');
      for (const entry of runs.nodes) {
        const run = asObject(entry, 'provider check run');
        const id = requiredString(run.id, 'provider check run id', true);
        const { status, conclusion } = checkRunState(run);
        if (status !== 'COMPLETED') continue;
        if (conclusion === null) throw providerShape('completed provider check run has no conclusion');
        if (conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') continue;
        const observedAt = requiredString(run.completedAt, 'provider check run completedAt');
        events.push(buildFeedbackEvent({
          provider: 'github',
          provider_event_id: id,
          publication_id: receipt.publication_id,
          head_sha: receipt.head_sha,
          failing_check_ids: [id],
          failing_checks: [{ id, conclusion: conclusion as FeedbackCheckConclusion }],
          unresolved_review_thread_ids: [],
          changes_requested_review_ids: [],
          mergeability: identity.mergeability,
          summary: `GitHub check run ${id} concluded ${conclusion}`,
          provider_url: identity.provider_url,
          observed_at: observedAt,
        }));
      }
      after = nextPageCursor(runs, 'provider check runs', seenCursors);
    } while (after !== null);
  }
  return events;
}

function unresolvedReviewEvents(identity: ProviderIdentity, receipt: FeedbackSubject, input: FeedbackObservationInput): readonly FeedbackEventV1[] {
  const events: FeedbackEventV1[] = [];
  let after: string | null = null;
  let pageCount = 0;
  const seenCursors = new Set<string>();
  do {
    if (pageCount >= MAX_PROVIDER_PAGES) throw providerIncomplete(`provider review threads pagination exceeds ${MAX_PROVIDER_PAGES} pages`);
    pageCount += 1;
    const graph = graphValue(input, REVIEW_THREAD_QUERY, [['repoId', identity.provider_repo_id], ['number', String(receipt.pr_number)]], after);
    const data = asObject(graph.data, 'provider GraphQL data');
    const repository = asObject(data.node, 'provider repository node');
    const pr = asObject(repository.pullRequest, 'provider pull request node');
    const threads = page(pr.reviewThreads, 'provider review threads');
    for (const entry of threads.nodes) {
      const thread = asObject(entry, 'provider review thread');
      const id = requiredString(thread.id, 'provider review thread id', true);
      if (requiredBoolean(thread.isResolved, 'provider review thread isResolved')) continue;
      events.push(buildFeedbackEvent({
        provider: 'github',
        provider_event_id: id,
        publication_id: receipt.publication_id,
        head_sha: receipt.head_sha,
        failing_check_ids: [],
        failing_checks: [],
        unresolved_review_thread_ids: [id],
        changes_requested_review_ids: [],
        mergeability: identity.mergeability,
        summary: `GitHub review thread ${id} remains unresolved`,
        provider_url: identity.provider_url,
        observed_at: requiredString(thread.updatedAt, 'provider review thread updatedAt'),
      }));
    }
    after = nextPageCursor(threads, 'provider review threads', seenCursors);
  } while (after !== null);
  return events;
}

/**
 * Review decision alone is not a durable provider event ID.  Query the review
 * connection itself so each CHANGES_REQUESTED decision is keyed by GitHub's
 * stable review object ID and pagination cannot silently hide another review.
 */
function changesRequestedReviewEvents(identity: ProviderIdentity, receipt: FeedbackSubject, input: FeedbackObservationInput): readonly FeedbackEventV1[] {
  const events: FeedbackEventV1[] = [];
  let after: string | null = null;
  let pageCount = 0;
  const seenCursors = new Set<string>();
  do {
    if (pageCount >= MAX_PROVIDER_PAGES) throw providerIncomplete(`provider reviews pagination exceeds ${MAX_PROVIDER_PAGES} pages`);
    pageCount += 1;
    const graph = graphValue(input, REVIEW_QUERY, [['repoId', identity.provider_repo_id], ['number', String(receipt.pr_number)]], after);
    const data = asObject(graph.data, 'provider GraphQL data');
    const repository = asObject(data.node, 'provider repository node');
    const pr = asObject(repository.pullRequest, 'provider pull request node');
    const reviews = page(pr.reviews, 'provider reviews');
    for (const entry of reviews.nodes) {
      const review = asObject(entry, 'provider review');
      const state = requiredString(review.state, 'provider review state');
      if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(state)) {
        throw providerShape(`provider review state is unknown: ${state}`);
      }
      if (state !== 'CHANGES_REQUESTED') continue;
      const id = requiredString(review.id, 'provider review id', true);
      events.push(buildFeedbackEvent({
        provider: 'github',
        provider_event_id: id,
        publication_id: receipt.publication_id,
        head_sha: receipt.head_sha,
        failing_check_ids: [],
        failing_checks: [],
        unresolved_review_thread_ids: [],
        changes_requested_review_ids: [id],
        mergeability: identity.mergeability,
        summary: `GitHub review ${id} requested changes`,
        provider_url: identity.provider_url,
        observed_at: requiredString(review.submittedAt, 'provider review submittedAt'),
      }));
    }
    after = nextPageCursor(reviews, 'provider reviews', seenCursors);
  } while (after !== null);
  return events;
}

/**
 * Build immutable events from a complete provider snapshot.  The surrounding
 * intake operation repeats this entire observation once when either provider
 * identity read changes; partial pages and unknown enums are never accepted.
 */
export function observeGitHubFeedback(receipt: FeedbackSubject, input: FeedbackObservationInput): readonly FeedbackEventV1[] {
  const before = observeIdentity(receipt, input);
  const events = [
    ...failedCheckEvents(before, receipt, input),
    ...unresolvedReviewEvents(before, receipt, input),
    ...changesRequestedReviewEvents(before, receipt, input),
  ];
  const after = observeIdentity(receipt, input);
  if (identityBytes(before) !== identityBytes(after)) throw new TornReadError('provider identity changed during feedback observation');
  assertStableIdentity(after, receipt);
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.provider_event_id)) throw providerShape(`provider event ID is ambiguous: ${event.provider_event_id}`);
    ids.add(event.provider_event_id);
  }
  return Object.freeze(events);
}

function showGraphNode(
  input: FeedbackObservationInput,
  query: string,
  id: string,
  after: string | null = null,
): Record<string, unknown> {
  const graph = graphValue(input, query, [['id', id]], after);
  if (Array.isArray(graph.errors) && graph.errors.length > 0) {
    throw providerIncomplete('provider GraphQL response contains errors');
  }
  const data = asObject(graph.data, 'provider GraphQL data');
  const node = asObject(data.node, 'provider feedback node');
  if (requiredString(node.id, 'provider feedback node id', true) !== id) {
    throw providerShape('provider feedback node does not match the requested provider event id');
  }
  return node;
}

function optionalDisplayText(value: unknown, label: string): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw providerShape(`${label} is invalid`);
  return value;
}

export function checkRunBody(input: FeedbackObservationInput, providerEventId: string): string {
  const node = showGraphNode(input, SHOW_CHECK_RUN_QUERY, providerEventId);
  const { status, conclusion } = checkRunState(node);
  const output = node.output === null ? null : asObject(node.output, 'provider check run output');
  const title = output === null ? '' : optionalDisplayText(output.title, 'provider check run output title');
  const summary = output === null ? '' : optionalDisplayText(output.summary, 'provider check run output summary');
  const text = output === null ? '' : optionalDisplayText(output.text, 'provider check run output text');
  return [
    `name: ${requiredString(node.name, 'provider check run name')}`,
    `status: ${status}`,
    `conclusion: ${conclusion ?? ''}`,
    `details_url: ${optionalDisplayText(node.detailsUrl, 'provider check run detailsUrl')}`,
    `title: ${title}`,
    `summary: ${summary}`,
    `text: ${text}`,
  ].join('\n');
}

export function reviewThreadBody(input: FeedbackObservationInput, providerEventId: string): string {
  const bodies: string[] = [];
  let after: string | null = null;
  let pageCount = 0;
  const seenCursors = new Set<string>();
  do {
    if (pageCount >= MAX_PROVIDER_PAGES) throw providerIncomplete(`provider review thread comments pagination exceeds ${MAX_PROVIDER_PAGES} pages`);
    pageCount += 1;
    const node = showGraphNode(input, SHOW_REVIEW_THREAD_QUERY, providerEventId, after);
    const comments = page(node.comments, 'provider review thread comments');
    for (const entry of comments.nodes) {
      const comment = asObject(entry, 'provider review thread comment');
      requiredString(comment.id, 'provider review thread comment id', true);
      const url = requiredString(comment.url, 'provider review thread comment URL');
      const body = optionalDisplayText(comment.body, 'provider review thread comment body');
      bodies.push(`${url}\n${body}`);
    }
    after = nextPageCursor(comments, 'provider review thread comments', seenCursors);
  } while (after !== null);
  return bodies.join('\n\n');
}

export function reviewBody(input: FeedbackObservationInput, providerEventId: string): string {
  const node = showGraphNode(input, SHOW_REVIEW_QUERY, providerEventId);
  const state = requiredString(node.state, 'provider review state');
  if (state !== 'CHANGES_REQUESTED') {
    throw providerShape(`provider review is no longer CHANGES_REQUESTED: ${state}`);
  }
  return [
    `url: ${requiredString(node.url, 'provider review URL')}`,
    `submitted_at: ${requiredString(node.submittedAt, 'provider review submittedAt')}`,
    optionalDisplayText(node.body, 'provider review body'),
  ].join('\n');
}
