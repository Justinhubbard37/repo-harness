import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decodeBoard, type BoardHostPortsV1, type BoardItemV1, type BoardPullRequestV1, type BoardV1 } from '../src/core/board/board';
import { DEFAULT_SEATS_CONFIG } from '../src/core/board/seats-settings';
import { candidateId, describeRuleStatus, ruleStatus, type RuleStatusV1, type RuleTaskProgress } from '../src/core/ci/rule-candidates';
import { candidateMarker, RULES_PARENT_MARKER } from '../src/core/ci/rule-prompt';
import * as collector from '../src/effects/board/collect';
import { collectRulesTasks } from '../src/effects/rules/tasks';
import { commitAll, initGitRepo, run, withTempRepo } from './helpers/repo-fixture';

const REPOSITORY = 'Ancienttwo/repo-harness';
const ID = candidateId(`github:${REPOSITORY}`, 'trace-trigger', 'enforce');
const URL = `https://github.com/${REPOSITORY}`;
const CLAIM = `${URL}/issues/1475#issuecomment-1`;
const TIME = '2026-11-02T18:34:59Z';
const recorded = decodeBoard(JSON.parse(readFileSync(join(import.meta.dir, '../src/operator-web/fixtures/board-1474.json'), 'utf8')));
const ACTIVE = { status: 'active', role: 'writer', created_at: TIME, url: CLAIM } as const;
const accepted = { status: 'accepted', via: 'record', accepted_at: TIME, evidence_url: `${URL}/pull/1491#issuecomment-2` } as const;
const success = { status: 'success', completed_at: TIME, contexts: [{ name: 'Required / CI', status: 'success' }] } as const;
const host: BoardHostPortsV1 = {
  seatTerminals: () => ({ status: 'observed', terminals: [] }),
  hcVersion: () => ({ status: 'observed', version: '0.1.30' }),
  closeoutTerminals: () => { throw new Error('unexpected closeout'); },
  advisorSend: () => { throw new Error('unexpected send'); },
  advisorRead: () => { throw new Error('unexpected advisor read'); },
  closeTerminal: () => { throw new Error('unexpected close'); },
};

function status(enforced = 'judgment'): RuleStatusV1 {
  return ruleStatus({ judgment: [], field_errors: [], evidence_errors: [], themes: [{
    key: 'trace-trigger', theme: 'trace-trigger', name: 'Trace trigger', seen: 3, enforced_by: enforced, promoted: null,
    lines: [3], prevention_rule: 'Trace the trigger.', why: 'Find the cause.', correction_sources: ['#10'],
  }] }, `github:${REPOSITORY}`, { head: 'a'.repeat(40), blob: 'b'.repeat(40), dirty: false });
}
function board(item: Partial<BoardItemV1> = {}, pr?: Partial<BoardPullRequestV1>): BoardV1 {
  return { ...recorded,
    plan: { status: 'observed', comment_url: `${URL}/issues/1474#issuecomment-3`, created_at: TIME, revision: 1,
      block: { protocol: 2, kind: 'repo-harness.plan', merge_order: [1475], holds: [], seat_limits: { worker: 1 } } },
    execution: { status: 'observed', terminals: [] },
    tooling: { hc: { status: 'observed', version: '0.1.30', min_version: '0.1.17' }, herdr_app: { status: 'not_pinned' } },
    items: [{ ...recorded.items[0]!, claim: { status: 'none' }, claim_status: { status_kind: 'none' }, pull_requests: pr ? [1491] : [], ...item }],
    pull_requests: pr ? [{ ...recorded.pull_requests.find(row => row.number === 1491)!, state: 'open', is_draft: false,
      required_check: success, acceptance: { status: 'not_accepted' }, review_fail: null, ...pr }] : [],
  };
}
function wireIssue(number: number, body: string) { return { number, body, html_url: `${URL}/issues/${number}` }; }
function comment(body: string, url = CLAIM) { return { body, url, createdAt: TIME, authorAssociation: 'MEMBER' }; }

/** Replay the recorded board parent wire shape; REST marker reads include two pages. */
function remote(options: { children?: ReturnType<typeof wireIssue>[]; parents?: ReturnType<typeof wireIssue>[]; fail?: string; coordinator?: boolean } = {}) {
  const wire = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/board/parent-1474.graphql.json'), 'utf8'));
  const parent = wire.data.repository.issue;
  const child = parent.subIssues.nodes[0];
  parent.subIssues.nodes = [child];
  child.timelineItems.nodes = [];
  child.comments.nodes = [comment('repo-harness issue claim\nRole: writer\nAgent: worker-important-fast, session t7\nSeat: orchestrator t1')];
  parent.comments.nodes = options.coordinator === false ? [] : [comment('repo-harness issue claim\nRole: coordinator')];
  const calls: readonly string[][] = [];
  const answer = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value) });
  const runner: NonNullable<collector.BoardCollectInput['gh_runner']> = args => {
    (calls as string[][]).push([...args]);
    if (options.fail && args.some(arg => arg.includes(options.fail!))) return { status: 1, stdout: '', stderr: 'private provider detail' };
    if (args[0] === 'repo') return answer({ nameWithOwner: REPOSITORY });
    if (args[1] === 'graphql') return answer(wire);
    if (args.some(arg => arg.endsWith('/sub_issues?per_page=100'))) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp');
      const rows = options.children ?? [wireIssue(1475, candidateMarker(ID, 'important_fast'))];
      return answer([rows.slice(0, 1), rows.slice(1)]);
    }
    if (args.some(arg => arg.endsWith('/issues?state=open&per_page=100'))) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp');
      return answer([[], options.parents ?? [wireIssue(1474, RULES_PARENT_MARKER)]]);
    }
    if (args.some(arg => arg.includes('/contents/') || arg.includes('/actions/'))) return { status: 1, stdout: '{"status":"404"}', stderr: 'Not found' };
    throw new Error(`unexpected gh read: ${args.join(' ')}`);
  };
  return { runner, calls, wire };
}
let boardSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { boardSpy?.mockRestore(); boardSpy = undefined; });
function enrich(fixture: BoardV1, source = remote(), document = status()) {
  boardSpy = spyOn(collector, 'collectBoard').mockReturnValue(fixture);
  return collectRulesTasks(document, { repo_root: '/unused', host, gh_runner: source.runner });
}
function task(document: RuleStatusV1) { return document.themes[0]!.actions[0]!.task; }

test.each([
  ['waiting_orchestration', board()],
  ['in_progress', board({ claim: ACTIVE })],
  ['ready_for_go', board({ claim: ACTIVE }, { acceptance: accepted })],
  ['merged', board({ state: 'closed' }, { state: 'merged' })],
  ['closed_unfinished', board({ state: 'closed' })],
  ['pr_rejected', board({}, { state: 'closed' })],
  ['failed', board({ claim_status: { status_kind: 'observed', status: 'released', url: CLAIM, created_at: TIME, pr: null, head_sha: null } })],
  ['unknown', board({ claim: { status: 'unknown' } })],
] as const)('projects %s from a board fixture without changing governance', (progress, fixture) => {
  const original = status();
  const result = enrich(fixture, remote(), original);
  expect(task(result)?.progress).toBe(progress);
  expect(result.ledger).toEqual(original.ledger);
  expect(result.themes[0]!.governance).toBe('judgment_unpromoted');
  expect(result.themes[0]!.actions).toHaveLength(2);
  expect(original.themes[0]!.actions[0]).not.toHaveProperty('task');
  expect(result.orchestration).toEqual({ parent: 1474, plan_comment: true, coordinator_claim: true });
});

test.each([
  [{ acceptance: accepted, is_draft: true }, 'in_progress'],
  [{ acceptance: accepted, required_check: { status: 'pending', contexts: [] } }, 'in_progress'],
  [{ acceptance: { status: 'not_accepted' } }, 'in_progress'],
  [{ review_fail: { url: CLAIM, recorded_at: TIME } }, 'pr_rejected'],
  [{ acceptance: { status: 'unknown', reason: 'comments_truncated', evidence_url: null } }, 'unknown'],
  [{ required_check: { status: 'unavailable', reason: 'provider private details' } }, 'unknown'],
] satisfies [Partial<BoardPullRequestV1>, RuleTaskProgress][])('uses current-head acceptance and checks: %j', (pr, expected) => {
  expect(task(enrich(board({ claim: ACTIVE }, pr)))?.progress).toBe(expected);
});

test('newest issue wins across pages; returns the claim seat and PR identity with both SHAs', () => {
  const fixture = board({ claim: ACTIVE }, { acceptance: accepted });
  const result = enrich(fixture, remote({ children: [wireIssue(1470, candidateMarker(ID, 'simple_fast')),
    wireIssue(1475, candidateMarker(ID, 'important_deep'))] }));
  expect(task(result)).toMatchObject({ issue: 1475, route: 'important_deep', seat: 'worker-important-fast',
    pull_request: { number: 1491, url: fixture.pull_requests[0]!.url,
      head_sha: fixture.pull_requests[0]!.head_sha, base_sha: fixture.pull_requests[0]!.base_sha } });
  expect(result.themes[0]!.actions[1]!.task).toBeNull();
  expect(describeRuleStatus(result).join('\n')).toContain('#1475 ready_for_go');
});

test('structural governance has no action or task, even when GitHub has a merged task', () => {
  const result = enrich(board({}, { state: 'merged' }), remote(), status('src/check.ts'));
  expect(result.themes[0]).toMatchObject({ governance: 'structural', actions: [] });
});

test.each(['version', 'execution'] as const)('hc unavailable at %s returns unknown with a stable reason', failure => {
  const fixture = board({ claim: ACTIVE }, { state: 'merged' });
  const changed: BoardV1 = failure === 'version'
    ? { ...fixture, tooling: { ...fixture.tooling, hc: { status: 'unavailable', reason: 'hc_missing' } } }
    : { ...fixture, execution: { status: 'unavailable', reason: 'hc_failed' } };
  expect(task(enrich(changed))).toMatchObject({ progress: 'unknown', reason: failure === 'version' ? 'hc_missing' : 'hc_failed' });
});

test('a missing parent is a complete no-task read; ambiguous or failed discovery is unknown', () => {
  for (const [source, expected] of [
    [remote({ parents: [] }), null],
    [remote({ parents: [wireIssue(1, RULES_PARENT_MARKER), wireIssue(2, RULES_PARENT_MARKER)] }), 'rules_parent_ambiguous'],
    [remote({ fail: '/issues?' }), 'github_read_failed'],
  ] as const) {
    const result = collectRulesTasks(status(), { repo_root: '/unused', host, gh_runner: source.runner });
    for (const action of result.themes[0]!.actions) {
      if (expected === null) expect(action.task).toBeNull();
      else expect(action.task).toEqual({ issue: null, url: null, route: null, progress: 'unknown', reason: expected, seat: null, pull_request: null });
    }
  }
});

test('a failed board read keeps discovered identities and does not leak provider details', () => {
  const source = remote({ fail: 'graphql' });
  const result = collectRulesTasks(status(), { repo_root: '/unused', host, gh_runner: source.runner });
  expect(task(result)).toMatchObject({ issue: 1475, progress: 'unknown', reason: 'github_read_failed' });
  expect(result.themes[0]!.actions[1]!.task).toBeNull();
  expect(JSON.stringify(result)).not.toContain('private provider detail');
});

test('the real board collector and source decoder compose without a live seat', () => {
  const source = remote({ coordinator: false });
  withTempRepo('rules-tasks-board', repo => {
    const result = collectRulesTasks(status(), { repo_root: repo, host, gh_runner: source.runner, seats: DEFAULT_SEATS_CONFIG });
    expect(task(result)).toMatchObject({ progress: 'in_progress', seat: 'worker-important-fast' });
    expect(result.orchestration).toEqual({ parent: 1474, plan_comment: false, coordinator_claim: false });
  });
});

test.each(['acme/override', undefined])('status board reads keep the status repository with GH_REPO=%s', override => {
  const prior = process.env.GH_REPO;
  if (override === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = override;
  try {
    const source = remote();
    const foreign = structuredClone(source.wire);
    foreign.data.repository.issue.subIssues.nodes[0].state = 'CLOSED';
    foreign.data.repository.issue.subIssues.nodes[0].comments.nodes = [];
    foreign.data.repository.issue.comments.nodes = [];
    const queries: readonly string[][] = [];
    const runner: NonNullable<collector.BoardCollectInput['gh_runner']> = args => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({
        nameWithOwner: args[2] === '--json' ? process.env.GH_REPO ?? 'acme/default' : args[2],
      }) };
      if (args[1] === 'graphql') {
        (queries as string[][]).push([...args]);
        if (!args.includes('owner=Ancienttwo') || !args.includes('name=repo-harness')) {
          return { status: 0, stdout: JSON.stringify(foreign) };
        }
      }
      return source.runner(args);
    };
    withTempRepo('rules-tasks-repository', repo => {
      const result = collectRulesTasks(status(), { repo_root: repo, host, gh_runner: runner, seats: DEFAULT_SEATS_CONFIG });
      expect(task(result)).toMatchObject({ url: `${URL}/issues/1475`, progress: 'in_progress', seat: 'worker-important-fast' });
      expect(result.orchestration?.coordinator_claim).toBe(true);
      expect(queries).toHaveLength(2);
      for (const args of queries) { expect(args).toContain('owner=Ancienttwo'); expect(args).toContain('name=repo-harness'); }
    });
  } finally {
    if (prior === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = prior;
  }
});

test('public CLI stays offline without --tasks and preserves ledger exit status on a failing GitHub runner', () => {
  withTempRepo('rules-tasks-cli', repo => {
    initGitRepo(repo);
    mkdirSync(join(repo, 'tasks'));
    writeFileSync(join(repo, 'tasks/lessons.md'), ['# Lessons', '', '- Date: 2026-10-01', '- Name: Trace trigger',
      '- Mistake pattern: trace-trigger', '- Prevention rule: Trace the trigger.', '- Why: Find the cause.',
      '- Enforced by: judgment', '- Triggered by correction: #10', '- Seen: 3×', ''].join('\n'));
    commitAll(repo, 'seed ledger');
    expect(run('git', ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`], repo).status).toBe(0);
    const log = join(repo, 'gh-calls');
    const fakeGh = join(repo, 'gh-fail');
    writeFileSync(fakeGh, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, 'read\\n'); process.stderr.write('private provider detail'); process.exit(1);\n`, { mode: 0o755 });
    const args = [join(import.meta.dir, '../src/cli/index.ts'), 'rules', 'status', '--target', repo, '--json'];
    const env = { REPO_HARNESS_GH_BIN: fakeGh };
    const offline = run('bun', args, repo, env);
    expect(offline.status).toBe(0);
    const plain = JSON.parse(offline.stdout);
    expect(plain).not.toHaveProperty('orchestration');
    expect(plain.themes[0].actions[0]).not.toHaveProperty('task');
    expect(() => readFileSync(log)).toThrow();
    for (const invalid of [false, true]) {
      if (invalid) writeFileSync(join(repo, 'tasks/lessons.md'), readFileSync(join(repo, 'tasks/lessons.md'), 'utf8').replace('Seen: 3×', 'Seen: bad'));
      const result = run('bun', [...args, '--tasks'], repo, env);
      expect(result.status).toBe(invalid ? 1 : 0);
      const document = JSON.parse(result.stdout);
      expect(document.ledger.valid).toBe(!invalid);
      if (!invalid) for (const action of document.themes[0].actions) expect(action.task.progress).toBe('unknown');
      expect(result.stdout + result.stderr).not.toContain('private provider detail');
    }
    expect(readFileSync(log, 'utf8')).toBe('read\nread\n');
  });
});
