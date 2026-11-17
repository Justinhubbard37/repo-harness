import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runRulesPromote, runRulesStatus } from '../src/cli/commands/rules';
import { candidateId, ruleStatus, type RuleStatusV1 } from '../src/core/ci/rule-candidates';
import { candidateMarker, promotionCandidate, renderPromotionPrompt, RULES_PARENT_MARKER, RulesPromoteError } from '../src/core/ci/rule-prompt';
import { sha256Hex } from '../src/core/evidence/sha256';
import { GithubAdapterError, type GithubCommandRunner } from '../src/effects/github/issues';
import { promoteRules, reconcileRules } from '../src/effects/rules/promote';
import { commitAll, initGitRepo, run, tmpWorkspace, withTempRepo } from './helpers/repo-fixture';

const REPOSITORY = 'github:acme/app';
const CANDIDATE = candidateId(REPOSITORY, 'trace-trigger', 'enforce');
const BLOB = 'b'.repeat(40);
const ROUTE = 'important_fast' as const;
const CLI = join(import.meta.dir, '../src/cli/index.ts');

function status(): RuleStatusV1 {
  return ruleStatus({ judgment: [], field_errors: [], evidence_errors: [], themes: [{
    key: 'trace-trigger', theme: 'trace-trigger', name: 'Trace trigger', seen: 3,
    enforced_by: 'judgment', promoted: null, lines: [3, 14],
    prevention_rule: 'Trace the trigger to its effect.', why: 'A symptom fix missed the cause.', correction_sources: ['#10', '#11'],
  }] }, REPOSITORY, { head: 'a'.repeat(40), blob: BLOB, dirty: false });
}

type RemoteIssue = { id: number; number: number; html_url: string; title: string; body: string; state: 'open' | 'closed'; labels: { name: string }[]; parent_issue_url?: string };
function issue(number: number, body: string): RemoteIssue {
  return { id: 1000 + number, number, html_url: `https://github.com/acme/app/issues/${number}`, title: 'task', body, state: 'open', labels: [] };
}

/** Stateful REST wire fixture: a failed write leaves prior writes available to the next call. */
function github(initial: RemoteIssue[] = [issue(10, RULES_PARENT_MARKER)], links: number[] = []) {
  const issues = initial;
  const calls: string[][] = [];
  const linked = new Map(links.map(id => [id, 10]));
  for (const row of issues) if (linked.has(row.id)) row.parent_issue_url = 'https://api.github.com/repos/acme/app/issues/10';
  let fail: 'labels' | 'sub_issues' | null = null;
  const runner: GithubCommandRunner = args => {
    calls.push([...args]);
    expect(args[0]).toBe('api');
    expect(args).toContain('github.com');
    const method = args[args.indexOf('--method') + 1];
    const path = args[args.indexOf('--method') + 2]!;
    expect(path.startsWith('repos/acme/app/issues')).toBe(true);
    const field = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const number = Number(path.split('/')[4]);
    const current = issues.find(row => row.number === number);
    let result: unknown;
    if (method === 'GET' && args.includes('--paginate')) {
      expect(args).toContain('--slurp');
      expect(args).toContain('per_page=100');
      const rows = path.endsWith('/sub_issues') ? issues.filter(row => linked.get(row.id) === number)
        : issues.filter(row => field('state') === 'all' || row.state === 'open');
      // More than one page, even for two rows, catches a first-page-only reader.
      result = rows.length === 0 ? [[]] : rows.map(row => [row]);
    } else if (method === 'GET') {
      if (!current) throw new Error(`Unexpected issue read: ${path}`);
      result = path.endsWith('/parent') ? issues.find(row => row.number === linked.get(current.id)) : current;
    } else if (path.endsWith('/labels')) {
      if (fail === 'labels') { fail = null; throw new GithubAdapterError('network', 'label request failed'); }
      current!.labels.push({ name: field('labels[]')! });
      result = current!.labels;
    } else if (path.endsWith('/sub_issues')) {
      if (fail === 'sub_issues') { fail = null; throw new GithubAdapterError('network', 'link request failed'); }
      const id = Number(field('sub_issue_id'));
      expect(issues.some(row => row.id === id)).toBe(true);
      linked.set(id, number);
      const child = issues.find(row => row.id === id)!;
      child.parent_issue_url = `https://api.github.com/repos/acme/app/issues/${number}`;
      result = child;
    } else if (method === 'POST' && path === 'repos/acme/app/issues') {
      const created = issue(Math.max(0, ...issues.map(row => row.number)) + 1, field('body')!);
      created.title = field('title')!;
      issues.push(created);
      result = created;
    } else throw new Error(`Unexpected GitHub command: ${args.join(' ')}`);
    return { stdout: JSON.stringify(result) };
  };
  return { runner, calls, issues, linked, failNext: (step: typeof fail) => { fail = step; },
    writes: () => calls.filter(args => args[args.indexOf('--method') + 1] === 'POST'),
    creates: () => calls.filter(args => args[args.indexOf('--method') + 1] === 'POST' && args[args.indexOf('--method') + 2] === 'repos/acme/app/issues') };
}

function promote(remote: ReturnType<typeof github>, overrides: Partial<Parameters<typeof promoteRules>[0]> = {}) {
  return promoteRules({ status: status(), candidate_id: CANDIDATE, route: ROUTE, ledger_blob: BLOB, ...overrides }, remote.runner);
}
function refusal(fn: () => unknown, code: string, issueNumber: number | null = null) {
  try { fn(); throw new Error('Expected a refusal'); }
  catch (error) { expect(error).toBeInstanceOf(RulesPromoteError); expect(error).toMatchObject({ code, issue: issueNumber }); }
}

describe('rules promotion and recovery', () => {
  test('creates the parent template and files exact prompt bytes with a route and sub-issue link', () => {
    const remote = github([]);
    const prompt = `Notes: 保留 bytes\r\n\r\n${candidateMarker(CANDIDATE, ROUTE)}\r\n`;
    const result = promote(remote, { prompt });
    expect(result).toEqual({ kind: 'repo-harness.rules.promote', protocol: 1, candidate_id: CANDIDATE,
      parent: 1, issue: 2, url: 'https://github.com/acme/app/issues/2', prompt_sha256: sha256Hex(prompt),
      steps: { issue: 'created', label: 'added', sub_issue: 'linked' } });
    expect(remote.issues[0]!.title).toBe('Batch: rules promotion');
    for (const heading of ['Goal', 'Children', 'Done when', 'Decisions']) expect(remote.issues[0]!.body).toContain(`## ${heading}`);
    expect(remote.issues[1]!.body).toBe(prompt);
    expect(remote.issues[1]!.title).toBe('rules: trace-trigger — enforce');
    const writes = remote.writes().length;
    refusal(() => promote(remote), 'candidate_open', 2);
    expect(remote.writes()).toHaveLength(writes);
    expect(remote.creates()).toHaveLength(2); // One parent and one task.
  });

  test.each(['labels', 'sub_issues'] as const)('recovers a failed %s step with one task creation and then no writes', step => {
    const remote = github();
    remote.failNext(step);
    refusal(() => promote(remote), 'github_network');
    const writes = remote.writes().length;
    refusal(() => promote(remote), 'candidate_open', 11);
    expect(remote.writes()).toHaveLength(writes);
    const result = reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, remote.runner);
    expect(result.steps).toEqual({ issue: 'found', label: step === 'labels' ? 'added' : 'present', sub_issue: 'linked' });
    const completedWrites = remote.writes().length;
    expect(reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, remote.runner).steps)
      .toEqual({ issue: 'found', label: 'present', sub_issue: 'present' });
    expect(remote.writes()).toHaveLength(completedWrites);
    expect(remote.creates()).toHaveLength(1);
  });

  test('reads linked duplicates on later pages and refuses an ambiguous parent without writing', () => {
    const child = issue(12, candidateMarker(CANDIDATE, ROUTE));
    const remote = github([issue(10, RULES_PARENT_MARKER), issue(11, 'unrelated'), child], [1011, child.id]);
    refusal(() => promote(remote), 'candidate_open', 12);
    expect(remote.calls.some(args => args.includes('repos/acme/app/issues/10/sub_issues'))).toBe(true);
    expect(remote.writes()).toHaveLength(0);
    remote.issues.push(issue(13, RULES_PARENT_MARKER));
    refusal(() => promote(remote), 'rules_parent_ambiguous');
    expect(remote.writes()).toHaveLength(0);
  });

  test.each([0, 1, 2])('reconcile retains a closed parent with %s open batches and writes nothing', openBatches => {
    const parent = issue(10, RULES_PARENT_MARKER);
    const task = issue(11, candidateMarker(CANDIDATE, ROUTE));
    parent.state = task.state = 'closed';
    task.labels.push({ name: `route:${ROUTE}` });
    const remote = github([parent, task,
      ...Array.from({ length: openBatches }, (_, index) => issue(12 + index, RULES_PARENT_MARKER))], [task.id]);
    const result = reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, remote.runner);
    expect(result).toMatchObject({ parent: 10, issue: 11, prompt_sha256: sha256Hex(task.body),
      steps: { issue: 'found', label: 'present', sub_issue: 'present' } });
    expect(remote.writes()).toHaveLength(0);
  });

  test.each(['open', 'closed'] as const)('reconcile retains a %s cross-repository parent without writes', state => {
    const parent = { ...issue(10, RULES_PARENT_MARKER), id: 2010, state,
      html_url: 'https://github.com/acme/planning/issues/10' };
    const task = issue(11, candidateMarker(CANDIDATE, ROUTE));
    task.labels.push({ name: `route:${ROUTE}` });
    task.parent_issue_url = 'https://api.github.com/repos/acme/planning/issues/10';
    const remote = github([issue(10, 'Unrelated issue with the same number'), task]);
    const runner: GithubCommandRunner = (args, options) => {
      if (args.includes('repos/acme/app/issues/11/parent')) {
        remote.calls.push([...args]);
        return { stdout: JSON.stringify(parent) };
      }
      return remote.runner(args, options);
    };
    const result = reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, runner);
    expect(result).toMatchObject({ parent: 10, issue: 11,
      steps: { issue: 'found', label: 'present', sub_issue: 'present' } });
    expect(remote.writes()).toHaveLength(0);
    expect(remote.calls.some(args => args.includes('repos/acme/app/issues/10/sub_issues'))).toBe(false);
    expect(task.parent_issue_url).toBe('https://api.github.com/repos/acme/planning/issues/10');
  });

  test('reconcile finds closed tasks and uses their stored route without a live candidate', () => {
    const task = issue(11, candidateMarker(CANDIDATE, 'simple_deep'));
    task.state = 'closed';
    const remote = github([issue(10, RULES_PARENT_MARKER), task]);
    const result = reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, remote.runner);
    expect(task.labels).toEqual([{ name: 'route:simple_deep' }]);
    expect(result.prompt_sha256).toBe(sha256Hex(task.body));
    expect(remote.creates()).toHaveLength(0);
    const absent = github([]);
    refusal(() => reconcileRules({ repository_id: REPOSITORY, candidate_id: CANDIDATE }, absent.runner), 'candidate_not_filed');
    expect(absent.writes()).toHaveLength(0);
  });

  test('invalid ledger, stale blob, dirty ledger and absent candidate make no GitHub call', () => {
    for (const [code, overrides] of [
      ['ledger_invalid', { status: { ...status(), ledger: { ...status().ledger, valid: false } } }],
      ['ledger_changed', { ledger_blob: 'c'.repeat(40) }],
      ['ledger_changed', { status: { ...status(), ledger: { ...status().ledger, dirty: true } } }],
      ['candidate_not_found', { candidate_id: '0'.repeat(64) }],
    ] as const) {
      const remote = github();
      refusal(() => promote(remote, overrides), code);
      expect(remote.calls).toHaveLength(0);
    }
  });

  test('missing, displaced, wrong-candidate and wrong-route prompt markers make no GitHub call', () => {
    for (const prompt of ['No marker', `${candidateMarker(CANDIDATE, ROUTE)}\nNotes`,
      candidateMarker('0'.repeat(64), ROUTE), candidateMarker(CANDIDATE, 'simple_fast')]) {
      const remote = github();
      refusal(() => promote(remote, { prompt }), 'prompt_marker_missing');
      expect(remote.calls).toHaveLength(0);
    }
  });

  test('both prompts carry lesson evidence, the enforcement ladder and the exact ledger change', () => {
    for (const kind of ['enforce', 'promote_root'] as const) {
      const id = candidateId(REPOSITORY, 'trace-trigger', kind);
      const prompt = renderPromotionPrompt(promotionCandidate(status(), id), ROUTE);
      for (const heading of ['Goal', 'Lesson', 'Enforcement ladder', 'Evidence', 'Ledger change', 'Boundaries', 'Additional notes']) {
        expect(prompt).toContain(`## ${heading}`);
      }
      for (const text of ['Trace the trigger to its effect.', 'A symptom fix missed the cause.', '#10', '#11', 'Do not change Seen']) expect(prompt).toContain(text);
      expect(prompt.trimEnd().split('\n').at(-1)).toBe(candidateMarker(id, ROUTE));
      expect(prompt).toContain(kind === 'enforce' ? 'replace judgment' : 'root AGENTS.md and root CLAUDE.md');
    }
  });
});

const LEDGER = ['# Lessons', '', '- Date: 2026-10-01', '- Name: Trace trigger', '- Mistake pattern: trace-trigger',
  '- Prevention rule: Trace the trigger to its effect.', '- Why: A symptom fix missed the cause.',
  '- Enforced by: judgment', '- Triggered by correction: #10, #11', '- Seen: 3×', ''].join('\n');

function seed(repo: string) {
  initGitRepo(repo);
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks/lessons.md'), LEDGER);
  commitAll(repo, 'record lesson');
  expect(run('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], repo).status).toBe(0);
}
function clean(repo: string) { expect(run('git', ['status', '--porcelain'], repo).stdout).toBe(''); }

test('CLI composition reads a real ledger and prompt file, keeps the target clean, and reconciles without the ledger', () => {
  withTempRepo('rules-promote', repo => {
    seed(repo);
    const scratch = tmpWorkspace('rules-promote-prompt');
    try {
      const remote = github();
      const document = runRulesStatus({ target: repo });
      const print = runRulesPromote({ target: repo, candidate: CANDIDATE, printPrompt: true }, remote.runner);
      expect(typeof print).toBe('string');
      expect(print).toContain('Why: A symptom fix missed the cause.');
      expect(remote.calls).toHaveLength(0);
      clean(repo);
      const prompt = `User notes\r\n${candidateMarker(CANDIDATE, ROUTE)}\r\n`;
      const promptFile = join(scratch, 'prompt.md');
      writeFileSync(promptFile, 'A prompt without its marker');
      refusal(() => runRulesPromote({ target: repo, candidate: CANDIDATE, route: ROUTE,
        ledgerBlob: document.ledger.blob, promptFile }, remote.runner), 'prompt_marker_missing');
      expect(remote.calls).toHaveLength(0);
      clean(repo);
      writeFileSync(promptFile, prompt);
      const result = runRulesPromote({ target: join(repo, 'tasks'), candidate: CANDIDATE, route: ROUTE,
        ledgerBlob: document.ledger.blob, promptFile }, remote.runner);
      expect(result).toMatchObject({ prompt_sha256: sha256Hex(readFileSync(promptFile, 'utf8')) });
      expect(remote.issues[1]!.body).toBe(prompt);
      clean(repo);
      appendFileSync(join(repo, 'tasks/lessons.md'), '\n');
      refusal(() => runRulesPromote({ target: join(repo, 'tasks'), candidate: CANDIDATE, route: ROUTE,
        ledgerBlob: document.ledger.blob }, remote.runner), 'ledger_changed');
      rmSync(join(repo, 'tasks/lessons.md'));
      expect(runRulesPromote({ target: repo, candidate: CANDIDATE, reconcile: true }, remote.runner))
        .toMatchObject({ steps: { issue: 'found', label: 'present', sub_issue: 'present' } });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

test('public CLI prints the default-route prompt and emits structured refusals before GitHub', () => {
  withTempRepo('rules-promote-cli', repo => {
    seed(repo);
    const printed = run('bun', [CLI, 'rules', 'promote', '--candidate', CANDIDATE, '--print-prompt', '--target', repo], repo);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toEndWith(`${candidateMarker(CANDIDATE, ROUTE)}\n`);
    clean(repo);
    const refused = run('bun', [CLI, 'rules', 'promote', '--candidate', CANDIDATE,
      '--route', ROUTE, '--ledger-blob', BLOB, '--target', repo, '--json'], repo);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toEqual({ kind: 'repo-harness.rules.promote', protocol: 1, error: { code: 'ledger_changed', issue: null } });
    clean(repo);
  });
});
