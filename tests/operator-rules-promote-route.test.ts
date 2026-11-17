import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRulesStatus } from '../src/cli/commands/rules';
import { promotionCandidate, renderPromotionPrompt } from '../src/core/ci/rule-prompt';
import { RULES_CLI_ENTRY, runRulesProcess, type RulesProcessRunner } from '../src/effects/operator/rules-collector';
import { rulesPromoteWriteRoute, rulesReconcileWriteRoute, type RulesPromoteRouteOptions } from '../src/effects/operator/rules-promote-route';
import { operatorAuditPath, operatorStateDir, readOperatorAuditRecords } from '../src/effects/operator/write-audit';
import { runOperatorWrite } from '../src/effects/operator/write-run';
import { repoHarnessRepoIdFor } from '../src/effects/repo-registry';
import { commitAll, initGitRepo, run, sandboxEnv, tmpWorkspace } from './helpers/repo-fixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const AT = '2026-11-17T00:00:00.000Z';

/** A stateful `gh api` double on PATH: the real CLI child files issues into a JSON state file. A flag file kills the CLI after a create. */
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const at = args.indexOf('--method');
const method = args[at + 1], path = args[at + 2];
const field = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const number = Number(path.split('/')[4]);
const find = n => state.issues.find(row => row.number === n);
let out, kill = false;
if (method === 'GET' && args.includes('--paginate')) {
  out = [path.endsWith('/sub_issues') ? state.issues.filter(row => state.links[row.id] === number) : state.issues.filter(row => field('state') === 'all' || row.state === 'open')];
} else if (method === 'GET') {
  out = path.endsWith('/parent') ? find(state.links[find(number).id]) : find(number);
} else if (path.endsWith('/labels')) {
  find(number).labels.push({ name: field('labels[]') }); out = [];
} else if (path.endsWith('/sub_issues')) {
  const id = Number(field('sub_issue_id'));
  state.links[id] = number;
  state.issues.find(row => row.id === id).parent_issue_url = 'https://api.github.com/repos/owner/repo/issues/' + number;
  out = {};
} else {
  const n = state.next++;
  out = { id: 1000 + n, number: n, html_url: 'https://github.com/owner/repo/issues/' + n, title: field('title'), body: field('body'), state: 'open', labels: [], parent_issue_url: null };
  state.issues.push(out);
  kill = out.body.includes('repo-harness.rules.candidate') && fs.existsSync(file + '.kill');
}
fs.writeFileSync(file, JSON.stringify(state));
if (kill) { fs.rmSync(file + '.kill'); process.kill(process.ppid, 'SIGKILL'); }
process.stdout.write(JSON.stringify(out));
`;

interface GhState { issues: { number: number; body: string; labels: { name: string }[]; parent_issue_url: string | null }[]; calls: string[][] }

function fixture() {
  const root = tmpWorkspace('operator-rules-promote'); roots.push(root);
  const repo = join(root, 'repo'), home = join(root, 'home'), bin = join(root, 'bin');
  for (const dir of [repo, home, bin, join(repo, 'tasks')]) mkdirSync(dir);
  writeFileSync(join(bin, 'gh'), FAKE_GH); chmodSync(join(bin, 'gh'), 0o755);
  const stateFile = join(root, 'gh-state.json');
  writeFileSync(stateFile, JSON.stringify({ issues: [], links: {}, next: 1, calls: [] }));
  initGitRepo(repo);
  expect(run('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], repo).status).toBe(0);
  writeFileSync(join(repo, 'README.md'), 'fixture'); commitAll(repo, 'fixture');
  const correction = run('git', ['rev-parse', 'HEAD'], repo).stdout.trim();
  writeFileSync(join(repo, 'tasks/lessons.md'), `# Lessons\n\n- Date: 2026-10-01\n- Name: Alpha\n- Mistake pattern: alpha\n- Prevention rule: Keep the evidence.\n- Why: The earlier fix missed the cause.\n- Enforced by: judgment\n- Triggered by correction: ${correction}, #10\n- Seen: 3×\n`);
  commitAll(repo, 'ledger');
  const id = repoHarnessRepoIdFor(repo);
  writeFileSync(join(home, 'registered-repos.json'), JSON.stringify({ version: 1, authorizationRevision: 1, repos: [
    { id, path: repo, accessMode: 'read_only', source: 'adopt', registeredAt: AT, lastSeenAt: AT },
  ] }));
  const env = sandboxEnv({ HOME: home, REPO_HARNESS_HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile });
  const status = runRulesStatus({ target: repo });
  const calls: (readonly string[])[] = [];
  const runner: RulesProcessRunner = (argv, options) => { calls.push(argv); return runRulesProcess(argv, options); };
  const state = { herdr: 'ready' as 'ready' | 'unavailable' };
  const options: RulesPromoteRouteOptions = {
    admit: work => work(new AbortController().signal), env, audit_env: env, run_process: runner,
    read_herdr: () => state.herdr,
  };
  const promoteRoute = rulesPromoteWriteRoute(options), reconcileRoute = rulesReconcileWriteRoute(options);
  const send = (route: typeof promoteRoute, requestId: string, fields: Record<string, unknown>) =>
    runOperatorWrite(requestId, route.decode(fields, [id]), env);
  const promote = (requestId: string, candidate: string, prompt = renderPromotionPrompt(promotionCandidate(status, candidate), 'important_fast')) =>
    send(promoteRoute, requestId, { candidate_id: candidate, route: 'important_fast', ledger_blob: status.ledger.blob, prompt });
  const reconcile = (requestId: string, candidate: string) => send(reconcileRoute, requestId, { candidate_id: candidate });
  const gh = () => JSON.parse(readFileSync(stateFile, 'utf8')) as GhState;
  const [first, second] = status.themes[0]!.actions.map(action => action.candidate_id);
  return { root, env, stateFile, calls, state, promote, reconcile, gh, first: first!, second: second! };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

test('one request_id files one issue; a new request answers candidate_open; another prompt answers request_mismatch; herdr unavailable starts no child', async () => {
  const f = fixture();
  const filed = await f.promote(uuid(1), f.first);
  expect(filed.status).toBe(200);
  expect(filed.body).toMatchObject({ candidate_id: f.first, steps: { issue: 'created', label: 'added', sub_issue: 'linked' } });
  expect(await f.promote(uuid(1), f.first)).toEqual(filed);
  const audit = readOperatorAuditRecords(operatorAuditPath(f.env)).filter(record => record.request_id === uuid(1));
  expect(audit.map(record => record.phase)).toEqual(['intent', 'result']);
  const issue = (filed.body as { issue: number }).issue;
  const open = await f.promote(uuid(2), f.first);
  expect(open).toMatchObject({ status: 409, body: { error: { code: 'candidate_open' }, issue } });
  expect(await f.promote(uuid(1), f.first, `${renderPromotionPrompt(promotionCandidate(runRulesStatus({ target: join(f.root, 'repo') }), f.first), 'important_fast')}\n`))
    .toMatchObject({ status: 409, body: { error: { code: 'request_mismatch' } } });
  expect(f.gh().issues.filter(row => row.body.includes(f.first))).toHaveLength(1);
  f.state.herdr = 'unavailable';
  const children = f.calls.length;
  expect(await f.promote(uuid(3), f.second)).toMatchObject({ status: 409, body: { error: { code: 'herdr_unavailable' } } });
  expect(await f.reconcile(uuid(4), f.first)).toMatchObject({ status: 409, body: { error: { code: 'herdr_unavailable' } } });
  expect(f.calls).toHaveLength(children);
  for (const body of [filed.body, open.body]) expect(JSON.stringify(body)).not.toContain(f.root);
});

test('a child stopped after the create leaves reconcile_required; the reconcile adds the label and link and keeps one issue', async () => {
  const f = fixture();
  writeFileSync(`${f.stateFile}.kill`, '');
  expect(await f.promote(uuid(5), f.second)).toMatchObject({ status: 409, body: { error: { code: 'reconcile_required' } } });
  expect(f.gh().issues.map(row => ({ labels: row.labels, linked: row.parent_issue_url !== null, candidate: row.body.includes(f.second) })))
    .toContainEqual({ labels: [], linked: false, candidate: true });
  // A crash leaves the prompt file; the reconcile removes it before its child runs.
  const prompts = join(operatorStateDir(f.env), 'rules-prompts');
  writeFileSync(join(prompts, `${f.second}.md`), 'left over');
  const reconciled = await f.reconcile(uuid(6), f.second);
  expect(reconciled).toMatchObject({ status: 200, body: { candidate_id: f.second, steps: { issue: 'found', label: 'added', sub_issue: 'linked' } } });
  expect(existsSync(join(prompts, `${f.second}.md`))).toBe(false);
  const filed = f.gh().issues.filter(row => row.body.includes(f.second));
  expect(filed).toHaveLength(1);
  expect(filed[0]!.labels).toEqual([{ name: 'route:important_fast' }]);
  expect(readdirSync(prompts)).toEqual([]);
  expect(f.calls.every(argv => argv[0] === RULES_CLI_ENTRY && argv[1] === 'rules' && argv[2] === 'promote')).toBe(true);
  expect(f.gh().calls.every(args => args[0] === 'api')).toBe(true);
});
