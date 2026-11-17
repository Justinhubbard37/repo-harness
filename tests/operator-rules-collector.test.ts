import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTING_CLASSES } from '../src/core/board/seats-settings';
import { ruleStatus } from '../src/core/ci/rule-candidates';
import { promotionCandidate, renderPromotionPrompt } from '../src/core/ci/rule-prompt';
import { decodeRulesSnapshot, RULES_UNAVAILABLE_REASONS, type RulesRouteV1, type RulesSnapshotV1 } from '../src/core/operator/rules';
import { startOperatorServer } from '../src/effects/operator/server';
import { RULES_CLI_ENTRY, RULES_COLLECT_INTERVAL_MS, RULES_COMMAND_TIMEOUT_MS, runRulesProcess, startRulesCollector, type RulesCollectorHandle, type RulesProcessRunner, type RulesRepositoryCache } from '../src/effects/operator/rules-collector';
import { repoHarnessRepoIdFor } from '../src/effects/repo-registry';
import { commitAll, initGitRepo, run, sandboxEnv, tmpWorkspace } from './helpers/repo-fixture';

const roots: string[] = [];
const collectors: RulesCollectorHandle[] = [];
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const AT = '2026-11-17T00:00:00.000Z';
function fixture() {
  const root = tmpWorkspace('operator-rules'); roots.push(root);
  const repo = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(repo); mkdirSync(home);
  const id = repoHarnessRepoIdFor(repo);
  const registry = join(home, 'registered-repos.json');
  const register = (present = true) => writeFileSync(registry, JSON.stringify({ version: 1, authorizationRevision: 1, repos: present ? [
    { id, path: repo, accessMode: 'read_only', source: 'adopt', registeredAt: AT, lastSeenAt: AT },
  ] : [] }));
  register();
  return { root, repo, home, id, registry, register, env: sandboxEnv({ HOME: home, REPO_HARNESS_HOME: home }) };
}
const ROUTES: readonly RulesRouteV1[] = ROUTING_CLASSES.map(task => task === 'frontend'
  ? { class: task, seat: null, runtime: null, model: null }
  : { class: task, seat: 'worker-light', runtime: 'pi', model: 'magpie/codex/gpt-6-astra' });
function snapshot(id = 'repo-a'): RulesSnapshotV1 {
  const ledger = ruleStatus({
    judgment: [], field_errors: [], evidence_errors: [], themes: [{ key: 'alpha', theme: 'alpha', name: 'Alpha', seen: 3,
      prevention_rule: 'Keep evidence.', why: 'The earlier fix missed the cause.', correction_sources: ['#10'],
      enforced_by: 'judgment', promoted: null, lines: [3] }],
  }, 'github:owner/repo', { head: 'a'.repeat(40), blob: 'b'.repeat(40), dirty: false });
  // The `--tasks` fields: one filed task with its pull request and one with no task.
  const [enforce, promote] = ledger.themes[0]!.actions;
  const status = { ...ledger, orchestration: { parent: 7, plan_comment: true, coordinator_claim: false }, themes: [{ ...ledger.themes[0]!, actions: [
    { ...enforce!, task: { issue: 8, url: 'https://github.com/owner/repo/issues/8', route: 'important_fast', progress: 'unknown', reason: 'claim_unknown',
      seat: 'worker-important', pull_request: { number: 9, url: 'https://github.com/owner/repo/pull/9', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40) } } },
    { ...promote!, task: null },
  ] }] } as RulesSnapshotV1['status'];
  const prompts = [enforce!, promote!].flatMap(action => ROUTING_CLASSES.map(route => ({
    candidate_id: action.candidate_id, route, prompt: renderPromotionPrompt(promotionCandidate(status, action.candidate_id), route),
  })));
  return { protocol: 1, kind: 'operator_rules', repository_id: id, collected_at: AT, status, prompts, routes: ROUTES, herdr: 'ready' };
}
function collect(options: Parameters<typeof startRulesCollector>[0]) {
  const collector = startRulesCollector(options); collectors.push(collector); return collector;
}

// Each string and each object can carry unsafe text or an undeclared field.
function paths(value: unknown, prefix: (string | number)[] = []): { strings: (string | number)[][]; objects: (string | number)[][] } {
  const result = { strings: [] as (string | number)[][], objects: [] as (string | number)[][] };
  if (typeof value === 'string') result.strings.push(prefix);
  else if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value)) result.objects.push(prefix);
    for (const [key, child] of Object.entries(value)) {
      const nested = paths(child, [...prefix, key]);
      result.strings.push(...nested.strings); result.objects.push(...nested.objects);
    }
  }
  return result;
}
test('decoder keeps CLI fields and refuses paths, terminal text and unknown fields at every depth', () => {
  const good = snapshot();
  const invalidLedger = { ...good, status: { ...good.status, ledger: { ...good.status.ledger, valid: false,
    field_errors: [{ line: 3, theme: '', field: 'Seen', value: '', fix: 'Use a count.' }],
    evidence_errors: [{ theme: 'alpha', trigger: 'Missing correction' }],
  } } };
  expect(decodeRulesSnapshot(invalidLedger)).toEqual(invalidLedger);
  const all = paths(invalidLedger);
  for (const path of all.strings) {
    for (const hidden of ['/', '/private/repo', 'at /tmp/repo', 'C:\\Users\\person', '\\\\host\\share', '\u001b[31mred']) {
      const copy = structuredClone(invalidLedger) as any;
      const parent = path.slice(0, -1).reduce((value, key) => value[key], copy);
      parent[path.at(-1)!] = hidden;
      expect(() => decodeRulesSnapshot(copy)).toThrow();
    }
  }
  for (const path of all.objects) {
    const copy = structuredClone(invalidLedger) as any;
    path.reduce((value, key) => value[key], copy).extra = 'undeclared';
    expect(() => decodeRulesSnapshot(copy)).toThrow();
  }
  for (const bad of [null, [], {}, { ...good, status: { ...good.status, themes: [good.status.themes[0], good.status.themes[0]] } }]) {
    expect(() => decodeRulesSnapshot(bad)).toThrow();
  }
});

test('collector reads only on its five-minute cycle, replaces failures, recovers and drops removed repositories', async () => {
  const f = fixture();
  let next!: () => void;
  let result: Awaited<ReturnType<RulesProcessRunner>> = { exit_code: 0, stdout: JSON.stringify(snapshot(f.id).status) };
  let calls = 0;
  const collector = collect({ env: { ...f.env, GIT_DIR: '/not-the-repository' }, read_routes: async () => ROUTES, read_herdr: () => 'ready', clock: {
    now: () => new Date(AT),
    setTimeout: (callback, ms) => { expect(ms).toBe(RULES_COLLECT_INTERVAL_MS); next = callback; return {} as ReturnType<typeof setTimeout>; },
    clearTimeout: () => {},
  }, run_process: async (argv, options) => {
    calls++;
    expect(argv).toEqual([RULES_CLI_ENTRY, 'rules', 'status', '--json', '--tasks', '--target', f.repo]);
    expect(options.cwd).toBe(f.repo);
    expect(options.env.GIT_DIR).toBeUndefined();
    expect(options.timeout_ms).toBe(RULES_COMMAND_TIMEOUT_MS);
    return result;
  } });
  expect(collector.read(f.id)).toEqual({ state: 'unavailable', reason: 'rules_pending' });
  await collector.settled();
  expect(collector.read(f.id)).toEqual({ state: 'ready', snapshot: snapshot(f.id) });
  collector.read(f.id); collector.read(f.id);
  expect(calls).toBe(1);
  expect(collector.read('missing')).toEqual({ state: 'unavailable', reason: 'repository_not_found' });
  for (const [response, reason] of [
    [null, 'rules_command_failed'], [{ exit_code: 2, stdout: '{}' }, 'rules_command_failed'],
    [{ exit_code: 1, stdout: '{}' }, 'rules_command_failed'], [{ exit_code: 0, stdout: 'bad JSON' }, 'rules_invalid'],
    [{ exit_code: 0, stdout: JSON.stringify({ ...snapshot().status, repository_id: '/tmp/private' }) }, 'rules_invalid'],
  ] as const) {
    result = response; next(); await collector.settled();
    expect(collector.read(f.id)).toEqual({ state: 'unavailable', reason });
  }
  result = { exit_code: 0, stdout: JSON.stringify(snapshot(f.id).status) };
  next(); await collector.settled();
  expect(collector.read(f.id).state).toBe('ready');
  writeFileSync(f.registry, 'broken'); next(); await collector.settled();
  expect(collector.read(f.id)).toEqual({ state: 'unavailable', reason: 'registry_unavailable' });
  f.register(false); next(); await collector.settled();
  expect(collector.read(f.id)).toEqual({ state: 'unavailable', reason: 'repository_not_found' });
});

test('real CLI output is served unchanged, including exit 1 ledger errors; GET starts no child', async () => {
  const f = fixture(); initGitRepo(f.repo);
  writeFileSync(join(f.repo, 'README.md'), 'fixture'); commitAll(f.repo, 'fixture');
  const correction = run('git', ['rev-parse', 'HEAD'], f.repo).stdout.trim();
  mkdirSync(join(f.repo, 'tasks'));
  const prevention = 'Keep the evidence for each observable trigger and its effect. '.repeat(20).trim();
  const why = 'The earlier fix treated a symptom and left the cause in place. '.repeat(20).trim();
  const ledger = (seen: string) => `# Lessons\n\n- Date: 2026-10-01\n- Name: Alpha\n- Mistake pattern: alpha\n- Prevention rule: ${prevention}\n- Why: ${why}\n- Enforced by: judgment\n- Triggered by correction: ${correction}, #10\n- Seen: ${seen}\n`;
  writeFileSync(join(f.repo, 'tasks/lessons.md'), ledger('3×'));
  commitAll(f.repo, 'ledger');
  let cache: RulesRepositoryCache = { state: 'unavailable', reason: 'rules_pending' };
  const server = await startOperatorServer({ port: 0, env: f.env, read_rules: () => cache });
  const url = `${server.url}/api/v1/repositories/${f.id}/rules`;
  try {
    for (const reason of RULES_UNAVAILABLE_REASONS) {
      cache = { state: 'unavailable', reason };
      const response = await fetch(url);
      expect(response.status).toBe(reason === 'repository_not_found' ? 404 : 503);
      expect(await response.json()).toMatchObject({ error: { code: reason } });
    }
    for (const valid of [true, false]) {
      writeFileSync(join(f.repo, 'tasks/lessons.md'), ledger(valid ? '3×' : 'not-a-count'));
      const cli = run(process.execPath, [RULES_CLI_ENTRY, 'rules', 'status', '--json', '--tasks', '--target', f.repo], f.repo, f.env);
      expect({ status: cli.status, stderr: cli.stderr }).toEqual({ status: valid ? 0 : 1, stderr: '' });
      const collector = collect({ env: f.env, read_routes: async () => null }); await collector.settled();
      cache = collector.read(f.id);
      expect(cache.state).toBe('ready');
      const spawn = spyOn(childProcess, 'spawn');
      const exec = spyOn(childProcess, 'execFile');
      const sync = spyOn(childProcess, 'spawnSync');
      try {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        const body = await response.json() as RulesSnapshotV1;
        expect(body.status).toEqual(JSON.parse(cli.stdout));
        expect(body.status.ledger.valid).toBe(valid);
        const actions = body.status.themes.flatMap(theme => theme.actions).length;
        if (valid) expect(actions).toBeGreaterThan(0);
        expect({ prompts: body.prompts.length, routes: body.routes, herdr: body.herdr })
          .toEqual({ prompts: valid ? actions * ROUTING_CLASSES.length : 0, routes: null, herdr: 'unavailable' });
        if (!valid) expect(body.status.ledger.field_errors.length).toBeGreaterThan(0);
        else {
          expect(body.status.themes).toHaveLength(1);
          expect(body.status.themes[0]).toMatchObject({
            prevention_rule: prevention, why, correction_sources: ['#10', correction],
          });
        }
        const head = await fetch(url, { method: 'HEAD' });
        expect(head.status).toBe(200); expect(await head.text()).toBe('');
        expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
      } finally { spawn.mockRestore(); exec.mockRestore(); sync.mockRestore(); }
      await collector.close();
    }
    for (const bad of [
      { ...snapshot(f.id), repository_id: 'different' },
      { ...snapshot(f.id), status: { ...snapshot().status, repository_id: '/tmp/private' } },
    ]) {
      cache = { state: 'ready', snapshot: bad };
      const response = await fetch(url);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: 'rules_invalid' } });
      expect(body).not.toContain('/tmp/private');
    }
    expect((await fetch(`${url}?force=true`)).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { Origin: server.url, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(405);
  } finally { await server.close(); }
});

test('bounded runner retains exit 1 stdout and refuses timeout, abort, output overflow and spawn failure', async () => {
  const f = fixture();
  const options = { cwd: f.repo, env: f.env, timeout_ms: 5000, signal: new AbortController().signal };
  expect(await runRulesProcess(['-e', 'console.log("document"); process.exitCode = 1'], options)).toEqual({ exit_code: 1, stdout: 'document\n' });
  expect(await runRulesProcess(['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout_ms: 50 })).toBeNull();
  expect(await runRulesProcess(['-e', 'process.stdout.write("x".repeat(4 * 1024 * 1024 + 1))'], options)).toBeNull();
  expect(await runRulesProcess([], { ...options, cwd: join(f.root, 'missing') })).toBeNull();
  const abort = new AbortController();
  const running = runRulesProcess(['-e', 'setInterval(() => {}, 1000)'], { ...options, signal: abort.signal });
  abort.abort(); expect(await running).toBeNull();
});

test('close aborts an active collection and waits for its runner', async () => {
  const f = fixture();
  let aborted = false;
  const collector = collect({ env: f.env, read_routes: async () => null, run_process: async (_argv, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
  }) });
  await collector.close(); expect(aborted).toBe(true);
});
