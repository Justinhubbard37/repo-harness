import { readReviewAdmissionSource } from '../src/effects/admission/admission-source';
import { seedReviewAdmissionFixture } from './helpers/review-admission-fixture';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { darwinTest } from './helpers/darwin-test';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { REVIEW_MAX_ROUNDS, validateReviewOutput } from '../src/core/review/generic-review';
import { composeReviewPacket, type ReviewPacketInput } from '../src/core/review/review-packet';
import { closeReview, reviewLocation, reviewStatus, runReviewRound, type ReviewEffects } from '../src/effects/review/generic-review';
import { reviewSessionOptions, taskReviewRunner } from '../src/effects/review-runner/task-review-runner';
import { resolvePiModel } from '../src/effects/pi-host-probe';
import { acceptanceContext, acceptanceReviewContextDigest, acceptanceReceiptPath } from '../scripts/acceptance-receipt';
import { seedAcceptanceFixture } from './helpers/verification-plan-fixture';
import { canonicalize } from '../src/core/evidence/canonical-json';
import type { JsonValue } from '../src/core/evidence/types';
import { prepareChangeAssessment } from '../src/effects/review/change-assessment';
import { executeAdmittedVerification, evaluateAdmittedVerification } from '../src/effects/evidence/verification-execution';
import { taskSessionDirectory, type HerdrCoreEndpoint, type HerdrTaskAgentSpec, type TaskPaneBinding } from '../src/effects/terminal/task-session-record';
import { observeTaskSessionAdmission } from '../src/effects/terminal/task-session-admission';
import { readSessionArtifact, writeSessionArtifact } from '../src/effects/terminal/task-session-io';
import { ensureSessionDirectory, nextSessionRound } from '../src/effects/terminal/task-session-io';
import type { ReviewHostSpec, TaskRequest } from '../src/core/review/runner-port';
import type { TaskSessionAuthority } from '../src/effects/admission/admission-source';
import { fixtureTemplate, tmpWorkspace, tmpWorkspaceIn } from './helpers/repo-fixture';
import { randomUUID } from 'crypto';
import { mockOfflineHerdr, offlineTerminalAddress, startOfflineTaskAgent } from './helpers/engineer-runtime-fixture';
import { buildTaskMessageEvent } from '../src/core/fleet/admitted-task-message';
import { readTaskMessageDelivery, sendTaskMessage } from '../src/effects/fleet/task-inbox';
import { recordPrePromptInboxAccepted } from '../src/effects/review-runner/task-pre-prompt-inbox-consumer';
import { OAR_OBSERVATION_PROTOCOL, oarObservationFile, type OarObservationSnapshot } from '../src/effects/terminal/task-runtime-observation';
type TaskReviewEffects = ReviewEffects<TaskPaneBinding, HerdrCoreEndpoint>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function expectNoStoredPiProbe(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) expectNoStoredPiProbe(path);
    else if (entry.isFile()) expect(readFileSync(path, 'utf8'), path).not.toContain('sk-PROBE-LITERAL');
  }
}

function resolveNode24(): string {
  const executable = Bun.which('node', { PATH: process.env.PATH ?? '' });
  if (!executable) throw new Error('OAR fixture requires Node 24 on PATH');
  const node = realpathSync(executable);
  const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({ node: process.versions.node, bun: process.versions.bun, executable: process.execPath })'], {
    encoding: 'utf8', timeout: 10_000,
  })) as { node?: string; bun?: string; executable: string };
  if (!/^24\./.test(runtime.node ?? '') || runtime.bun !== undefined || realpathSync(runtime.executable) !== node) {
    throw new Error('OAR fixture requires the resolved PATH executable to be Node 24');
  }
  return node;
}

test('generic review refuses tampered empty and missing approved plans before any provider starts on every platform', async () => {
  for (const reason of ['empty_plan', 'missing_plan']) {
    const { root, home, authority, admissionFixture, verification } = seedAcceptanceFixture('gp');
    roots.push(root, home);
    const reviewerRepo = join(home, 'reviewer');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'incomplete-plan-reviewer', reviewerRepo]);
    const file = join(admissionFixture.directory, admissionFixture.grant.slice(7) + '.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (reason === 'empty_plan') record.admission.verification_plan.checks = [];
    else delete record.admission.verification_plan;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const calls: string[] = [];
    const effects: TaskReviewEffects = { ...taskReviewRunner,
      owner: () => { calls.push('owner'); throw new Error('provider lookup must not run'); },
      installation: async () => { calls.push('installation'); throw new Error('provider probe must not run'); },
      start: async () => { calls.push('start'); throw new Error('provider start must not run'); },
    };
    await expect(runReviewRound({ repoRoot: root, authority, verification, reviewerRepo, authorityHome: home,
      endpoint: { socket: join(home, 'hc.sock'), home }, parentPane: 'fixture-owner-pane',
      taskClaim: { reference: 'https://github.com/acme/widgets/issues/903#issuecomment-1', revision: 'sha256:' + 'c'.repeat(64) }, admitSession: () => { calls.push('admit'); } }, effects)).rejects.toThrow('grant_digest');
    expect(calls).toEqual([]);
    expect(existsSync(acceptanceReceiptPath(root, home))).toBe(false);
  }
}, 60_000);
// The shared fixture supplies explicit synthetic upstream approval. These cases
// retain the production CLI source loader; only account-home/provider transport
// are offline boundaries. A runtime sentinel stops before any agent is launched.
for (const selection of [
  { kind: 'labels' as const, labels_all: ['review'], assignees_any: [] },
  { kind: 'issue_numbers' as const, issue_numbers: [903, 904] },
]) {
  test(`review, verification and linked session admission resolve the approved issue under ${selection.kind} discovery`, async () => {
    const f = seedAcceptanceFixture('selected-issue'); roots.push(f.root, f.home);
    const policyPath = join(f.root, '.ai/harness/policy.json');
    const existing = JSON.parse(readFileSync(policyPath, 'utf8'));
    const policy = f.admissionFixture.policy;
    if (policy.mode !== 'manual') throw new Error('expected manual fixture policy');
    writeFileSync(policyPath, JSON.stringify({ ...existing, external_sources: { version: 1, mode: 'manual',
      github: { ...policy.github, selection, limits: { ...policy.github.limits, max_issues: 2 } } } }));
    const admission = f.admissionFixture.admission;
    const loaded = readReviewAdmissionSource(f.root, { 'repository-id': admission.repository_id, 'issue-id': admission.issue_id,
      'campaign-id': admission.campaign_id, 'grant-sha256': f.admissionFixture.grant,
      'policy-sha256': admission.policy.policy_sha256, actor: admission.actor_id });
    expect(loaded.issuePolicy.mode).toBe('manual');
    if (loaded.issuePolicy.mode !== 'manual') throw new Error('expected loaded manual policy');
    // The loader must not rewrite discovery policy to manufacture an admission.
    expect(loaded.issuePolicy.github.selection).toEqual(selection);
    const endpoints: string[] = [];
    const runner: NonNullable<typeof loaded.runner> = (args, options) => {
      const endpoint = args.find(arg => arg.startsWith('repos/'))!;
      endpoints.push(endpoint);
      expect(['repos/acme/widgets', 'repos/acme/widgets/issues/903']).toContain(endpoint);
      return f.authority.runner!(args, options);
    };
    const authority = { ...loaded, authorityHome: f.home, runner };
    const verification = executeAdmittedVerification({ repoRoot: f.root, authority, reportFile: f.verification });
    expect(verification.passed).toBe(true);
    expect(verification.results[0]!.execution).toBe('executed');
    const evaluated = evaluateAdmittedVerification({ repoRoot: f.root, authority });
    expect(evaluated.passed).toBe(true);
    expect(evaluated.results[0]!.execution).toBe('reused');
    expect(evaluated.results[0]!.execution_id).toBe(verification.results[0]!.execution_id);
    const prepared = prepareChangeAssessment({ repoRoot: f.root, authority });
    const basis = { schema: 'repo-harness-change-assessment-evidence.v1', status: 'pass', assessment: prepared.assessment, selection_packet: prepared.packet };
    writeFileSync(join(f.root, '.ai/harness/checks/change-assessment.latest.json'), JSON.stringify({ ...basis,
      evidence_sha256: 'sha256:' + createHash('sha256').update(canonicalize(basis as unknown as JsonValue)).digest('hex') }));
    const reviewerRepo = join(f.home, 'reviewer');
    execFileSync('git', ['-C', f.root, 'worktree', 'add', '-qb', 'selected-issue-reviewer', reviewerRepo]);
    const taskClaim = { reference: 'https://github.com/acme/widgets/issues/903#issuecomment-1', revision: 'sha256:' + 'c'.repeat(64) };
    const session = observeTaskSessionAdmission(reviewerRepo, { task: 'selected-issue', role: 'deep-reasoner', harness_kind: 'codex' }, 'herdr-core', { source: authority, claim: taskClaim });
    expect(session.identity.issue_id).toBe(admission.issue_id);
    expect(session.identity.execution_root).toBe(reviewerRepo);
    expect(session.approval.grant_sha256).toBe(f.admissionFixture.grant);
    let ownerCalls = 0;
    await expect(runReviewRound({ repoRoot: f.root, authority, verification: f.verification, reviewerRepo, authorityHome: f.home,
      endpoint: { socket: join(f.home, 'hc.sock'), home: f.home }, parentPane: 'fixture-owner', taskClaim,
      admitSession: () => { throw new Error('must not launch'); } }, { ...taskReviewRunner,
      owner: () => { ownerCalls++; throw new Error('offline-runtime-boundary-reached'); },
    })).rejects.toThrow('offline-runtime-boundary-reached');
    expect(ownerCalls).toBe(1);
    expect(endpoints.filter(endpoint => endpoint.endsWith('/issues/903')).length).toBeGreaterThan(1);
    for (const patch of [{ id: 'replacement-issue' }, { body: 'unapproved goal change' }]) {
      const changed = { ...authority, runner: ((args, options) => args.includes('repos/acme/widgets/issues/903')
        ? { stdout: JSON.stringify({ ...f.admissionFixture.issue, ...patch }) } : runner(args, options)) as typeof runner };
      const refusal = 'id' in patch ? 'review_goal_identity_changed' : 'review_admission_goal_or_actor_changed';
      expect(() => evaluateAdmittedVerification({ repoRoot: f.root, authority: changed })).toThrow(refusal);
      expect(() => observeTaskSessionAdmission(reviewerRepo, { task: 'selected-issue', role: 'deep-reasoner', harness_kind: 'codex' }, 'herdr-core', { source: changed, claim: taskClaim })).toThrow(refusal);
    }
  }, 60_000);
}

const identity = { request_id: 'r', context_sha256: 'domain-context', subject_sha256: 'subject', actual_harness: 'claude' as const, actual_role: 'deep-reasoner', actual_model: 'fixture-model' };
const finding = { id: 'f', severity: 'P1' as const, status: 'new' as const, message: '[fixture opinion] fix the fence' };
const fail = { ...identity, verdict: 'FAIL', summary: '[fixture opinion] revise', findings: [finding] };
const packetInput: ReviewPacketInput = Object.freeze({ context_sha256: 'domain-context', subject_sha256: 'subject',
  actual_harness: 'claude', actual_role: 'deep-reasoner', prior_findings: Object.freeze([Object.freeze(finding)]),
  admission: 'admission\n', goal: 'goal\n', verification: 'verification\n', source: 'source\n' });
test('review packet preserves the exact transport text, domain identity and prior findings', () => {
  // Frozen pre-extraction bytes. Do not derive this expectation from the builder or shared rule.
  const expected = [
    'Review the complete current subject against its goal, approved admission and prepared verification evidence. Do not edit production code or invoke other reviewers. Only author one final JSON file to the exact request.result_ref; no temp/rename or alternate submission. Terminal output and idle are observation only.',
    'Outer transport JSON is {request_id: request.request_id, context_sha256: request.context_sha256, value: domain output}. Provider value has EXACTLY request_id, context_sha256, subject_sha256, verdict, summary, findings. Domain request_id is request.request_id; domain context_sha256 is the prepared domain hash below (distinct from transport packet hash). The owner adds actual harness/role/model from the bound task-agent and OAR Session observation, not your self-description.',
    'PASS requires no unresolved P0/P1. FAIL requires at least one unresolved finding. Each finding has EXACTLY id, severity:P0|P1|P2|P3, status:new|open|resolved, message. Keep stable IDs: every prior finding must remain resolved/open with current evidence. A previous verdict is not evidence for current code.',
    'DOMAIN IDENTITY: {"context_sha256":"domain-context","subject_sha256":"subject","actual_harness":"claude","actual_role":"deep-reasoner"}',
    'PRIOR FINDINGS: [{"id":"f","severity":"P1","status":"new","message":"[fixture opinion] fix the fence"}]',
    'APPROVED ADMISSION:\nadmission\n', 'GOAL:\ngoal\n', 'PREPARED VERIFICATION:\nverification\n', 'CURRENT SOURCE:\nsource\n',
  ].join('\n\n');
  expect(Buffer.from(composeReviewPacket(packetInput))).toEqual(Buffer.from(expected));
  expect(composeReviewPacket(packetInput)).toBe(composeReviewPacket(packetInput));
  const codex = composeReviewPacket({ ...packetInput, actual_harness: 'codex', prior_findings: [] });
  expect(codex).toContain('"actual_harness":"codex","actual_role":"deep-reasoner"');
  expect(codex).toContain('PRIOR FINDINGS: []');
});

test('review packet enforces the existing 10 MiB limit in UTF-8 bytes without truncation', () => {
  const input = { ...packetInput, source: '' };
  const remaining = 10 * 1024 * 1024 - Buffer.byteLength(composeReviewPacket(input));
  const source = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  const packet = composeReviewPacket({ ...input, source });
  expect(Buffer.byteLength(packet)).toBe(10 * 1024 * 1024);
  expect(packet.endsWith(source)).toBe(true);
  expect(() => composeReviewPacket({ ...input, source: source + 'x' })).toThrow('review_context_too_large');
});

const packetRepositoryTemplate = fixtureTemplate(() => {
  const fixture = seedAcceptanceFixture('review-packet');
  execFileSync('git', ['-C', fixture.root, 'worktree', 'add', '-qb', 'packet-reviewer', join(fixture.home, 'reviewer')]);
  return fixture;
}, fixture => [fixture.root, fixture.home]);
afterAll(() => packetRepositoryTemplate.dispose());

/** The repo's own pi 1.5.2 package; its resolver runs offline with an empty credential store. */
const PI_PACKAGE_CLI = join(import.meta.dir, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
/** A resolver double for fixtures that do not test model resolution: the settings reference is canonical. */
const piReferenceResolver = (_agentDirectory: string, reference: string) =>
  ({ provider: reference.slice(0, reference.indexOf('/')), model: reference.slice(reference.indexOf('/') + 1) });
const inOneHour = () => Date.now() + 3_600_000;
/** The generated review configuration (#2764): magpie constants only. */
const MAGPIE_PI_MODELS = { providers: { magpie: { baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-completions', apiKey: 'magpie',
  models: [{ id: 'codex/gpt-6-astra', reasoning: true }] } } };
const MAGPIE_PI_SETTINGS = { defaultProvider: 'magpie', defaultModel: 'codex/gpt-6-astra', defaultThinkingLevel: 'high' };
const MAGPIE_CODEX_CONFIG = 'model = "codex/gpt-6-astra"\nmodel_provider = "magpie"\n\n[model_providers.magpie]\nname = "magpie"\n'
  + 'base_url = "http://127.0.0.1:3425/v1"\nwire_api = "responses"\nexperimental_bearer_token = "magpie"\n'
  + 'http_headers = { "x-openai-actor-authorization" = "magpie" }\n';
/** Each generated file is a 0600 regular file, never a link; pi's auth.json is the empty map. */
function expectGeneratedPiDirectory(directory: string): void {
  expect(readdirSync(directory).sort()).toEqual(['auth.json', 'models.json', 'settings.json']);
  for (const name of ['auth.json', 'models.json', 'settings.json']) {
    const stat = lstatSync(join(directory, name));
    expect([stat.isFile(), stat.isSymbolicLink(), stat.mode & 0o777], name).toEqual([true, false, 0o600]);
  }
  expect(readFileSync(join(directory, 'auth.json'), 'utf8')).toBe('{}');
  expect(JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8'))).toEqual(MAGPIE_PI_MODELS);
  expect(JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))).toEqual(MAGPIE_PI_SETTINGS);
}
function packetRoundFixture() {
  const seed = packetRepositoryTemplate.materialize();
  const fixture = { ...seed, authority: { ...seed.authority } };
  roots.push(fixture.root, fixture.home);
  // Match the acceptance fixture's short, private endpoint HOME.
  const endpointHome = tmpWorkspaceIn('/tmp', 'rp');
  roots.push(endpointHome);
  const endpoint = { socket: join(endpointHome, 'hc.sock'), home: endpointHome };
  const reviewerRepo = join(fixture.home, 'reviewer');
  const location = reviewLocation(fixture.root, fixture.authority);
  const packetPath = (round = 1) => join(reviewerRepo, '.ai/harness/runs/generic-review-input', location.key, `packet-${round}.txt`);
  const calls: string[] = [];
  const effects: TaskReviewEffects = { ...taskReviewRunner,
    installation: async (_kind, executable) => { calls.push('installation'); return { kind: 'available', via: 'executable', command: executable ?? '/usr/bin/true' }; },
    start: async (_repo, _spec, _command, _ready, _guard, taskAuthority) => {
      expect(taskAuthority?.source).toBe(fixture.authority);
      expect(taskAuthority?.claim).toEqual(options.taskClaim);
      calls.push('start');
      expect(readFileSync(packetPath(), 'utf8')).toContain('CURRENT SOURCE:');
      expect(lstatSync(packetPath()).mode & 0o777).toBe(0o600);
      throw new Error('fixture_start_failure');
    },
    send: async () => { calls.push('send'); throw new Error('must not send'); },
    piReviewLaunchBlocker: () => null, resolvePiModel: (_executable, agentDirectory, reference) => piReferenceResolver(agentDirectory, reference),
    assertMagpieReachable: async () => {},
  };
  const refresh = () => {
    const report = executeAdmittedVerification({ repoRoot: fixture.root, authority: fixture.authority, reportFile: fixture.verification });
    expect(report.passed).toBe(true);
    const prepared = prepareChangeAssessment({ repoRoot: fixture.root, authority: fixture.authority });
    const basis = { schema: 'repo-harness-change-assessment-evidence.v1', status: 'pass', assessment: prepared.assessment, selection_packet: prepared.packet };
    writeFileSync(join(fixture.root, '.ai/harness/checks/change-assessment.latest.json'), JSON.stringify({ ...basis,
      evidence_sha256: 'sha256:' + createHash('sha256').update(canonicalize(basis as unknown as JsonValue)).digest('hex'),
    }, null, 2) + '\n');
  };
  const options = { repoRoot: fixture.root, authority: fixture.authority, verification: fixture.verification, reviewerRepo,
    authorityHome: fixture.home, endpoint, parentPane: 'fixture-owner-pane',
    harness: 'claude' as const, taskClaim: { reference: 'https://github.com/acme/widgets/issues/903#issuecomment-1', revision: 'sha256:' + 'c'.repeat(64) }, admitSession: () => { calls.push('admit'); } };
  return { ...fixture, ...location, options, effects, calls, packetPath, refresh };
}

test('packet composition failure starts no pane and saves no packet or request', async () => {
  const f = packetRoundFixture();
  writeSessionArtifact(join(f.dir, 'request-1.json'), { subject_sha256: 'previous-subject' });
  writeSessionArtifact(join(f.dir, 'accepted-1.json'), { output: { findings: [{ ...finding, message: 'x'.repeat(10 * 1024 * 1024) }] } });
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow('review_context_too_large');
  expect(f.calls).toEqual(['installation', 'admit']);
  expect(existsSync(f.packetPath(2))).toBe(false);
  expect(existsSync(join(f.dir, 'request-2.json'))).toBe(false);
  expect(existsSync(acceptanceReceiptPath(f.root, f.home))).toBe(false);
}, 60_000);

test('a saved session with an unknown harness is refused without a Receipt', async () => {
  const f = packetRoundFixture();
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow();
  const path = join(f.dir, 'session.json');
  const session = readSessionArtifact<Record<string, unknown>>(path);
  writeFileSync(path, JSON.stringify({ ...session, actual_harness: 'unknown' }));
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow('review_harness_unsupported');
  expect(existsSync(acceptanceReceiptPath(f.root, f.home))).toBe(false);
}, 60_000);

test('packet survives launch failure; same input retries and changed subject fails before launch', async () => {
  const f = packetRoundFixture();
  // Linux keeps the real isolation refusal. Darwin reaches the injected start
  // failure. Neither case starts a real pane or a provider process.
  const launchError = process.platform === 'darwin' ? 'fixture_start_failure' : 'OAR_REVIEW_ISOLATION_UNSUPPORTED_PLATFORM';
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow(launchError);
  const packet = readFileSync(f.packetPath(), 'utf8');
  const modifiedAt = lstatSync(f.packetPath()).mtimeMs;
  expect(packet).toContain('CURRENT SOURCE:');
  expect(packet).toContain('+candidate');
  expect(lstatSync(f.packetPath()).mode & 0o777).toBe(0o600);
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow(launchError);
  expect(readFileSync(f.packetPath(), 'utf8')).toBe(packet);
  expect(lstatSync(f.packetPath()).mtimeMs).toBe(modifiedAt);
  expect(f.calls.filter(call => call === 'start')).toHaveLength(process.platform === 'darwin' ? 2 : 0);
  const beforeChangedRetry = [...f.calls];
  writeFileSync(join(f.root, 'feature.txt'), 'candidate\n\n');
  f.refresh();
  await expect(runReviewRound(f.options, f.effects)).rejects.toThrow('review_packet_changed_before_send; packet for round 1 is preserved. Inspect with rh review status');
  expect(f.calls).toEqual(beforeChangedRetry);
  expect(readFileSync(f.packetPath(), 'utf8')).toBe(packet);
  expect(existsSync(join(f.dir, 'request-1.json'))).toBe(false);
  expect(existsSync(f.packetPath(2))).toBe(false);
  expect(f.calls).not.toContain('send');
  expect(existsSync(acceptanceReceiptPath(f.root, f.home))).toBe(false);
}, 60_000);

darwinTest('app-terminal round returns the exact host command, sends nothing and never asks for a relaunch', async () => {
  const f = packetRoundFixture();
  await expect(runReviewRound({ ...f.options, launch: 'app-terminal' }, f.effects)).rejects.toThrow('review_launch_addressing_invalid');
  const { endpoint: _endpoint, parentPane: _parentPane, ...base } = f.options;
  await expect(runReviewRound(base, f.effects)).rejects.toThrow('review_launch_addressing_invalid');
  const options = { ...base, launch: 'app-terminal' as const, timeoutMs: 3000 };
  const first = await runReviewRound(options, f.effects);
  if (first.status !== 'launch_required') throw new Error('fixture_launch_required_expected');
  expect(first.argv.slice(1)).toEqual(['--disable-sigusr1', realpathSync(join(import.meta.dir, '../dist/oar-review-host.js')), join(f.dir, 'host.json')]);
  expect(first.argv[0]!.startsWith('/')).toBe(true);
  expect(first.command).toBe(first.argv.map(arg => "'" + arg + "'").join(' '));
  expect(first.cwd).toBe(realpathSync(f.options.reviewerRepo));
  const session = readSessionArtifact<Record<string, unknown>>(join(f.dir, 'session.json'));
  expect([session.endpoint, session.parent_pane, session.actual_harness]).toEqual([null, null, 'claude']);
  expect(session.task_claim).toEqual(options.taskClaim);
  await expect(runReviewRound({ ...options, taskClaim: { ...options.taskClaim, revision: 'sha256:' + 'b'.repeat(64) } }, f.effects)).rejects.toThrow('review_session_spec_changed');
  expect(existsSync(join(f.dir, 'request-1.json'))).toBe(false);
  expect(readFileSync(f.packetPath(), 'utf8')).toContain('CURRENT SOURCE:');
  // Repeating the round before any host claims the directory returns the same command and admits no new session.
  expect(await runReviewRound(options, f.effects)).toEqual(first);
  // A launch after the admitted deadline opens no Session and holds no claim; the repeated round admits a new deadline.
  const admitted = readSessionArtifact<{ deadline: number }>(join(f.dir, 'launch-deadline.json')).deadline;
  await Bun.sleep(admitted - Date.now() + 50);
  const late = spawnSync(first.argv[0]!, first.argv.slice(1), { cwd: first.cwd, encoding: 'utf8', timeout: 30_000 });
  expect(late.stderr).toContain('OAR_HOST_LAUNCH_DEADLINE_PASSED');
  expect(existsSync(join(f.dir, 'host-claim.json'))).toBe(false);
  expect(await runReviewRound(options, f.effects)).toEqual(first);
  expect(readSessionArtifact<{ deadline: number }>(join(f.dir, 'launch-deadline.json')).deadline).toBeGreaterThan(admitted);
  expect(f.calls.filter(call => call === 'admit')).toHaveLength(1);
  expect(f.calls).not.toContain('start');
  expect(f.calls).not.toContain('send');
  // A host that claimed the directory and exited before ready is a failure, never a relaunch request.
  const exited = spawnSync('/usr/bin/true');
  writeSessionArtifact(join(f.dir, 'host-claim.json'), { pid: exited.pid });
  await expect(runReviewRound(options, f.effects)).rejects.toThrow('review_host_start_failed');
  expect((reviewStatus(f.root, f.options.authority, taskReviewRunner) as { lifecycle: { status: string } }).lifecycle.status).toBe('launch_pending');
  // After Session opening began, a host exit without a disposal receipt is not cleanup proof.
  writeSessionArtifact(join(f.dir, 'session-opening.json'), { pid: exited.pid });
  await expect(closeReview(f.root, f.options.authority, true, f.home, taskReviewRunner)).rejects.toThrow('review_host_cleanup_pending');
  expect(reviewStatus(f.root, f.options.authority, taskReviewRunner).status).toBe('open');
  writeSessionArtifact(join(f.dir, 'disposed.json'), { disposed: true, fixture: false });
  expect((await closeReview(f.root, f.options.authority, true, f.home, taskReviewRunner)).status).toBe('closed');
  expect(existsSync(join(f.dir, 'close.request'))).toBe(true);
  expect(reviewStatus(f.root, f.options.authority, taskReviewRunner).status).toBe('closed');
  expect(existsSync(acceptanceReceiptPath(f.root, f.home))).toBe(false);
}, 60_000);

darwinTest('app-terminal cancel before any claim leaves a tombstone, so a late launch opens no Session', async () => {
  const f = packetRoundFixture();
  const { endpoint: _endpoint, parentPane: _parentPane, ...base } = f.options;
  const launch = await runReviewRound({ ...base, launch: 'app-terminal' }, f.effects);
  if (launch.status !== 'launch_required') throw new Error('fixture_launch_required_expected');
  expect((await closeReview(f.root, f.options.authority, true, f.home, taskReviewRunner)).status).toBe('closed');
  const claim = join(f.dir, 'host-claim.json');
  expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual({ pid: null, closed: true });
  const late = spawnSync(launch.argv[0]!, launch.argv.slice(1), { encoding: 'utf8', timeout: 30_000 });
  expect(late.status).not.toBe(0);
  expect(late.stderr).toContain('EEXIST');
  expect(existsSync(join(f.dir, 'ready.json'))).toBe(false);
  expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual({ pid: null, closed: true });
}, 60_000);

test('packet fixtures keep valid socket paths with a long UTF-8 temporary root', () => {
  const temp = tmpWorkspaceIn('/tmp', 'packet-' + 'é'.repeat(52)); roots.push(temp);
  expect(temp.length).toBeLessThan(103);
  expect(Buffer.byteLength(temp, 'utf8')).toBeGreaterThan(107);
  // Set startup variables only in the child. Keep the real isolation preload
  // and run the original assertions, including the Darwin launch failure.
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, NO_COLOR: '1' };
  // Bun hides pass lines in agent environments, even with onlyFailures=false.
  for (const key of ['CLAUDECODE', 'REPL_ID', 'AGENT']) delete env[key];
  const result = spawnSync(process.execPath, ['--no-env-file', 'test', import.meta.path,
    '--test-name-pattern', '^packet (composition failure|survives launch failure)',
    '--timeout', '60000', '--max-concurrency', '1'], {
    cwd: join(import.meta.dir, '..'),
    env,
    encoding: 'utf8', timeout: 50_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  expect(result.error, output).toBeUndefined();
  expect(result.signal, output).toBeNull();
  expect(result.status, output).toBe(0);
  expect(output).toContain('(pass) packet composition failure starts no pane and saves no packet or request');
  expect(output).toContain('(pass) packet survives launch failure; same input retries and changed subject fails before launch');
}, 60_000);

test('generic review validates exact domain binding, verdict, stable findings and no launch fields', () => {
  expect(validateReviewOutput(fail, identity).verdict).toBe('FAIL');
  for (const field of Object.keys(identity)) expect(() => validateReviewOutput({ ...fail, [field]: 'different' }, identity)).toThrow(`review_${field}_mismatch`);
  expect(() => validateReviewOutput({ ...fail, session_id: 'launcher' }, identity)).toThrow('review_malformed_result');
  expect(() => validateReviewOutput({ ...fail, verdict: 'PASS' }, identity)).toThrow('review_conflicting_verdict');
  expect(() => validateReviewOutput({ ...fail, findings: [finding, finding] }, identity)).toThrow('review_malformed_finding');
  expect(() => validateReviewOutput(fail, identity, [finding])).toThrow('review_previous_finding_unaddressed');
  expect(() => validateReviewOutput({ ...fail, findings: [] }, identity, [finding])).toThrow('review_previous_finding_unaddressed');
  const resolved = { ...finding, status: 'resolved' as const };
  expect(validateReviewOutput({ ...fail, verdict: 'PASS', findings: [resolved] }, identity, [finding]).findings).toEqual([resolved]);
});
test('three-round accounting survives reopen; pending and duplicate subjects cannot replay', () => {
  const root = tmpWorkspace('generic-review-budget'); roots.push(root); const dir = join(root, 'rounds'); ensureSessionDirectory(root, dir);
  const subject = (value: { subject: string }) => value.subject;
  expect(nextSessionRound(dir, REVIEW_MAX_ROUNDS, 'a', subject)).toBe(1);
  writeSessionArtifact(join(dir, 'request-1.json'), { subject: 'a' });
  expect(() => nextSessionRound(dir, REVIEW_MAX_ROUNDS, 'b', subject)).toThrow('task_agent_ambiguous_round');
  writeSessionArtifact(join(dir, 'accepted-1.json'), {});
  expect(() => nextSessionRound(dir, REVIEW_MAX_ROUNDS, 'a', subject)).toThrow('task_agent_duplicate_subject');
  for (let round = 2; round <= 3; round++) {
    expect(nextSessionRound(dir, REVIEW_MAX_ROUNDS, String(round), subject)).toBe(round);
    writeSessionArtifact(join(dir, `request-${round}.json`), { subject: String(round) });
    writeSessionArtifact(join(dir, `accepted-${round}.json`), {});
  }
  expect(() => nextSessionRound(dir, REVIEW_MAX_ROUNDS, 'fourth', subject)).toThrow('task_agent_round_budget_exhausted');
});
test('OAR SessionOptions reuse fleet and authorize only file communication, without vendor argv', () => {
  const root = tmpWorkspace('generic-review-options'); roots.push(root);
  const home = join(root, '.codex-home');
  const claude = reviewSessionOptions('claude', root), codex = reviewSessionOptions('codex', root, home);
  expect(claude.cwd).toBe(root); expect(codex.cwd).toBe(root);
  // Codex runs the review role's target model as its magpie model.
  expect(claude.model).toBe('opus'); expect(codex.model).toBe('codex/gpt-6-astra');
  expect(codex.effort).toBe('high'); expect(codex.env).toEqual({ CODEX_HOME: home });
  expect(() => reviewSessionOptions('codex', root)).toThrow('review_runtime_home_required');
  for (const [options, keys] of [[claude, ['appendSystemPrompt','cwd','effort','model']], [codex, ['appendSystemPrompt','cwd','effort','env','model']]] as const) {
    expect(options.appendSystemPrompt).toContain('RECOMMENDATION:');
    expect(options.appendSystemPrompt).toContain('exact result_ref');
    expect(Object.keys(options).sort()).toEqual([...keys]);
  }
});

test('Pi agent directory holds only the magpie constants and an empty auth map; the native auth paths are gone', async () => {
  const { mkdirSync, chmodSync, symlinkSync, unlinkSync } = await import('node:fs');
  const isolation = await import('../src/effects/review/review-isolation');
  const { assertHostLaunchAdmitted } = await import('../src/effects/review-runner/task-oar-host');
  // The native auth link, its lock policy, the credential window and the cleanup routes are gone.
  for (const name of ['assertPiCredentialWindow', 'removePiCredentialReferences', 'removeCopiedAuth']) expect(Object.hasOwn(isolation, name), name).toBe(false);
  const root = tmpWorkspace('pi-home'); roots.push(root);
  const output = join(root, 'output'); mkdirSync(output);
  // pi's own offline resolver selects the review role's magpie model from the generated files.
  const { directory, model } = isolation.preparePiAgentDirectory(output, (agentDirectory, reference) => resolvePiModel(PI_PACKAGE_CLI, agentDirectory, reference));
  expect(model).toBe('magpie/codex/gpt-6-astra');
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expectGeneratedPiDirectory(directory);
  expect(isolation.preparePiAgentDirectory(output, piReferenceResolver).directory).toBe(directory);
  expect(() => isolation.preparePiAgentDirectory(output, () => ({ provider: 'magpie', model: 'codex/other' })))
    .toThrow('review_pi_model_not_canonical: pi resolves magpie/codex/gpt-6-astra to magpie/codex/other');
  const settings = readFileSync(join(directory, 'settings.json'), 'utf8');
  writeFileSync(join(directory, 'settings.json'), settings + ' ');
  expect(() => isolation.preparePiAgentDirectory(output, piReferenceResolver)).toThrow('review_pi_settings_changed');
  writeFileSync(join(directory, 'settings.json'), settings);
  unlinkSync(join(directory, 'auth.json')); symlinkSync(join(root, 'elsewhere.json'), join(directory, 'auth.json'));
  expect(() => isolation.preparePiAgentDirectory(output, piReferenceResolver)).toThrow('review_pi_auth_changed');
  chmodSync(directory, 0o755);
  expect(() => isolation.preparePiAgentDirectory(output, piReferenceResolver)).toThrow('directory_unsafe');
  const otherOutput = join(root, 'other'); mkdirSync(otherOutput); symlinkSync(directory, join(otherOutput, '.pi-agent'));
  expect(() => isolation.preparePiAgentDirectory(otherOutput, piReferenceResolver)).toThrow('directory_unsafe');
  // The host refuses a native session that starts at or after the owner's round deadline.
  const control = join(root, `control-${randomUUID()}`); mkdirSync(control);
  const hostSpec = { kind: 'pi', controlDirectory: control } as ReviewHostSpec;
  const launchAt = (deadline: unknown) => writeSessionArtifact(join(control, 'launch-deadline.json'), { deadline }, false);
  const lateDeadline = Date.now() + 1500;
  launchAt(lateDeadline);
  expect(assertHostLaunchAdmitted(hostSpec, false)).toBe(lateDeadline);
  launchAt('later');
  expect(() => assertHostLaunchAdmitted(hostSpec, false)).toThrow('OAR_HOST_LAUNCH_DEADLINE_INVALID');
  launchAt(lateDeadline);
  await Bun.sleep(1600);
  expect(() => assertHostLaunchAdmitted(hostSpec, false)).toThrow(/OAR_HOST_LAUNCH_DEADLINE_PASSED.*repeat the round/);
  // After host-claim.json, a repeated round cannot launch again; the recovery is cancel and restart.
  expect(() => assertHostLaunchAdmitted(hostSpec, true)).toThrow(/OAR_HOST_LAUNCH_DEADLINE_PASSED.*cancel the review and start a new one/);
});

darwinTest('Pi isolation fixture: OAR flags, native extension, actual model and paired denials', async () => {
  const { mkdirSync, chmodSync } = await import('node:fs');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { preparePiAgentDirectory, reviewIsolationPolicy, prepareReviewLauncher, reviewHostTemporaryDirectory } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('pi-isolation'); roots.push(root);
  const home = join(root, 'home'), source = join(root, 'source'), owner = join(root, 'owner'), output = join(root, 'output');
  for (const path of [home, source, owner, output]) mkdirSync(path);
  const agent = join(home, '.pi/agent'); mkdirSync(agent, { recursive: true });
  // The native pi configuration in HOME stays unread and unwritable.
  const credential = join(agent, 'auth.json');
  writeFileSync(credential, JSON.stringify({ openai: { type: 'api_key', key: 'fixture-key-no-provider-call' } }));
  writeFileSync(join(agent, 'models.json'), '{"providers":{}}');
  writeFileSync(join(agent, 'settings.json'), '{"defaultProvider":"openai","defaultModel":"gpt-4o"}');
  mkdirSync(join(agent, 'extensions')); writeFileSync(join(agent, 'extensions', 'unexpected.ts'), 'throw new Error("ambient fixture extension loaded");');
  const { directory, model } = preparePiAgentDirectory(output, piReferenceResolver);
  writeSessionArtifact(join(owner, 'launch-deadline.json'), { deadline: inOneHour() }, false);
  expectGeneratedPiDirectory(directory);
  const targets = [join(source, 'protected.txt'), credential, join(agent, 'protected.txt'), join(directory, 'auth.json'), join(directory, 'models.json'), join(agent, 'models.json'), join(directory, 'settings.json'), join(agent, 'settings.json')];
  for (const target of [targets[0]!, targets[2]!]) writeFileSync(target, 'KEEP');
  const initial = targets.map(path => readFileSync(path, 'utf8'));
  const paths = { subject: source, primary: source, ownerRecord: owner, journal: owner, gitCommonDir: source, output, piAgentDirectory: directory, magpie: true };
  const profile = join(owner, 'isolation.sb'); writeFileSync(profile, reviewIsolationPolicy(paths), { mode: 0o600 });
  const node = resolveNode24(), fixture = join(root, 'fixture-pi.cjs'), capture = join(output, 'argv.jsonl');
  const piCli = realpathSync(join(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '..', 'cli.js'));
  const probe = `()=>{const fs=require('node:fs');const denied=${JSON.stringify(targets)}.map(path=>{try{fs.writeFileSync(path,'CHANGED');return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}});let signal=false;try{process.kill(${process.pid},'SIGCONT')}catch(e){signal=e.code==='EPERM'};const refused=f=>{try{f();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};const nativeLock=refused(()=>fs.mkdirSync(${JSON.stringify(realpathSync(credential) + '.lock')}));const lock=${JSON.stringify(join(realpathSync(directory), 'auth.json.lock'))};let isolatedLock=false;try{fs.mkdirSync(lock);fs.utimesSync(lock,new Date(),new Date());fs.rmdirSync(lock);isolatedLock=true}catch{};return {denied,signal,nativeLock,isolatedLock};}`;
  writeFileSync(fixture, `#!${node}\nconst fs=require('node:fs'),cp=require('node:child_process');
const argv=process.argv.slice(2);
const check=${probe};
const descendant=JSON.parse(cp.execFileSync(process.execPath,['-e',${JSON.stringify(`console.log(JSON.stringify((${probe})()))`)}],{encoding:'utf8'}));
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({fixture:true,argv,env:{PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR,OAR_PI_AGENT_DIR:process.env.OAR_PI_AGENT_DIR,OAR_PI_RPC_DIRECTORY:process.env.OAR_PI_RPC_DIRECTORY},own:check(),descendant})+'\\n');
const child=cp.spawn(process.execPath,[${JSON.stringify(piCli)},...argv],{stdio:argv.includes('--version')?'inherit':['inherit','inherit','inherit',3]});child.on('exit',code=>process.exit(code??1));
`); chmodSync(fixture, 0o700);
  const launcher = prepareReviewLauncher(owner, profile, fixture);
  const entry = pathToFileURL(realpathSync(join(import.meta.dir, '../dist/oar-review-host.js'))).href;
  const worker = join(root, 'open.mjs');
  writeFileSync(worker, `import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';
import {reviewRuntime,OarReviewHost,openReviewHost} from ${JSON.stringify(entry)};
import {SessionManager} from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
const runtime=reviewRuntime('pi',${JSON.stringify(launcher)});
const session=await runtime.session({kind:'available',via:'bundled'},{cwd:${JSON.stringify(output)},env:{PI_CODING_AGENT_DIR:${JSON.stringify(directory)},OAR_PI_AGENT_DIR:${JSON.stringify(directory)}}});
const host=new OarReviewHost(session,()=>{});const id=host.sessionId;
try{assert.ok(id);assert.equal(host.model('pi'),'magpie/codex/gpt-6-astra');const records=readFileSync(${JSON.stringify(capture)},'utf8').trim().split('\\n').map(JSON.parse);const run=records.find(r=>r.argv.includes('--mode'));assert.ok(existsSync(run.env.OAR_PI_RPC_DIRECTORY+'/ready'));}finally{await host.dispose();}
const output=${JSON.stringify(output)},agentDir=${JSON.stringify(directory)};
const captured=readFileSync(${JSON.stringify(capture)},'utf8').trim().split('\\n').map(JSON.parse).find(r=>r.argv.includes('--session-dir'));
const native=SessionManager.create(output,captured.argv[captured.argv.indexOf('--session-dir')+1]);
native.appendMessage({role:'user',content:'[fixture transcript; no provider run]',timestamp:Date.now()});
const spec={mode:'review',kind:'pi',installation:{kind:'available',via:'bundled'},launcher:${JSON.stringify(launcher)},vendorExecutable:${JSON.stringify(fixture)},options:{cwd:output,resume:native.getSessionId(),model:${JSON.stringify(model)},env:{PI_CODING_AGENT_DIR:agentDir,OAR_PI_AGENT_DIR:agentDir}},requestDirectory:${JSON.stringify(owner)},output,controlDirectory:${JSON.stringify(owner)},timeoutMs:5000,isolation:${JSON.stringify({ paths, policyFile: profile })}};
for(let i=0;i<2;i++){const resumed=i===0?await openReviewHost(spec,()=>{}):new OarReviewHost(await runtime.session(spec.installation,spec.options),()=>{});try{assert.equal(resumed.sessionId,native.getSessionId());assert.equal(resumed.model('pi'),${JSON.stringify(model)});}finally{await resumed.dispose();}}
console.log(JSON.stringify({session_id:id,model:${JSON.stringify(model)},extension_ready:true,resumed:true}));
`);
  const result = spawnSync(node, [worker], { encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: reviewHostTemporaryDirectory(output) } });
  expect(result.status, result.stderr).toBe(0);
  const observed = JSON.parse(result.stdout);
  expect(observed.extension_ready).toBe(true); expect(observed.model).toBe('magpie/codex/gpt-6-astra'); expect(observed.session_id).toBeTruthy(); expect(observed.resumed).toBe(true);
  const captures = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = captures.find(row => row.argv.includes('--mode'));
  for (const flag of ['--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--no-approve', '--offline']) expect(run.argv).toContain(flag);
  expect(run.argv[run.argv.indexOf('--mode') + 1]).toBe('rpc'); expect(run.argv).toContain('-e');
  expect(run.env.PI_CODING_AGENT_DIR).toBe(directory); expect(run.env.OAR_PI_AGENT_DIR).toBe(directory);
  for (const row of captures) for (const evidence of [row.own, row.descendant]) { expect(evidence.denied).toEqual(targets.map(() => true)); expect(evidence.signal).toBe(true); expect([evidence.nativeLock, evidence.isolatedLock]).toEqual([true, true]); }
  expect(targets.map(path => readFileSync(path, 'utf8'))).toEqual(initial);
}, 60000);

test('Pi review options run the magpie model in the isolated directory; an unobserved model is null for every runtime', async () => {
  const { isReviewRuntimeId } = await import('../src/core/review/review-runtimes');
  const { validateDomainReview } = await import('../src/core/review/acceptance-receipt');
  const { decodeAgentsConfig } = await import('../src/core/board/agents-settings');
  expect(isReviewRuntimeId('pi')).toBe(true);
  const { oarActualModel } = await import('../src/effects/terminal/task-runtime-observation');
  const reported = (value: string | null) => ({ model: () => ({ value }) }) as unknown as Parameters<typeof oarActualModel>[1];
  expect(() => oarActualModel('pi', reported('unknown/unknown'))).toThrow('pi_actual_model_unresolved');
  expect(oarActualModel('pi', reported(null))).toBeNull();
  expect(decodeAgentsConfig({ enabled: ['pi'], uses: { docs: [], review: ['pi'] }, default_docs: null }).uses.review).toEqual(['pi']);
  expect(() => reviewSessionOptions('pi', '/fixture')).toThrow('review_runtime_home_required');
  const options = reviewSessionOptions('pi', '/fixture', '/fixture/.pi-agent');
  expect(options.env).toEqual({ PI_CODING_AGENT_DIR: '/fixture/.pi-agent', OAR_PI_AGENT_DIR: '/fixture/.pi-agent' });
  expect(options.model).toBe('magpie/codex/gpt-6-astra'); expect(options.effort).toBeUndefined();
  const identity = { request_id: 'fixture', context_sha256: 'sha256:' + 'a'.repeat(64), subject_sha256: 'sha256:' + 'b'.repeat(64),
    actual_harness: 'pi' as const, actual_role: 'deep-reasoner', actual_model: 'fixture-provider/fixture-actual' };
  const result = { ...identity, verdict: 'PASS' as const, summary: '[fixture opinion]', findings: [] };
  expect(validateReviewOutput(result, identity).actual_model).toBe(identity.actual_model);
  expect(validateDomainReview(result).actual_model).toBe(identity.actual_model);
  for (const actual_harness of ['claude', 'codex', 'pi'] as const) {
    expect(validateDomainReview({ ...result, actual_harness, actual_model: null }).actual_model).toBeNull();
    expect(validateReviewOutput({ ...result, actual_harness, actual_model: null }, { ...identity, actual_harness, actual_model: null }).actual_model).toBeNull();
    expect(() => validateReviewOutput({ ...result, actual_harness, actual_model: null }, { ...identity, actual_harness })).toThrow('actual_model_mismatch');
    expect(() => validateDomainReview({ ...result, actual_harness, actual_model: '' })).toThrow();
    expect(() => validateReviewOutput({ ...result, actual_harness, actual_model: '' }, { ...identity, actual_harness, actual_model: '' })).toThrow('review_actual_model_unverified');
  }
});

test('Pi execution fixture projects and validates its native resume identity', async () => {
  const { projectTaskExecutionView, decodeTaskExecutionView } = await import('../src/core/operator/execution-state');
  const view = projectTaskExecutionView({ protocol: 1, kind: 'operator_task_execution', observed_at: '2026-10-28T00:00:00.000Z',
    executions: [{ state: 'verified', task: 'fixture-pi', role: 'deep-reasoner', issue_id: '1100', branch: 'fixture-pi',
      agent: 'pi', runtime: 'terminal', native_session_id: 'fixture-native-id', hc_terminal: null }] }, 'fixture-repo', null,
    () => { throw new Error('a terminal session has no hc terminal'); });
  expect(decodeTaskExecutionView(view)).toEqual(view);
  expect(view.tasks[0]!.follow_up.resume).toEqual({ host: 'pi', command: 'pi --session fixture-native-id' });
  const first = view.tasks[0]!;
  const invalid = { ...view, tasks: [{ ...first, follow_up: { ...first.follow_up,
    resume: { host: 'pi', command: 'pi --session fixture-native-id; touch forbidden' } } }] };
  expect(() => decodeTaskExecutionView(invalid)).toThrow('resume command');
});

for (const example of [
  { verdict: 'PASS' as const },
  { verdict: 'FAIL' as const },
]) darwinTest(`Pi review fixture records ${example.verdict} with native model identity`, async () => {
  const { bindNativeTaskSession } = await import('../src/effects/terminal/native-task-session');
  const { verifyAcceptance } = await import('../src/effects/review/acceptance-receipt');
  const f = packetRoundFixture();
  let binding: Awaited<ReturnType<typeof startOfflineTaskAgent>>, request: TaskRequest;
  let actualModel: string | null = 'fixture-provider/fixture-actual', verdict = example.verdict, sent = 0;
  const effects: TaskReviewEffects = { ...f.effects, assertBinding: () => {}, piExecutable: () => '/usr/bin/true',
    dispose: async () => {}, close: async () => ({ status: 'closed', pids: [] }), cancel: async () => ({ status: 'closed', pids: [] }),
    installation: async () => ({ kind: 'available', via: 'bundled' }),
    start: async (repo, spec, _command, _ready, _guard, authority) => {
      if (!authority) throw new Error('fixture_task_authority_missing');
      if (!binding) {
        binding = await startOfflineTaskAgent(repo, spec, authority);
        writeSessionArtifact(join(f.dir, 'ready.json'), { pid: binding.provider.pid, session_id: 'fixture-pi-native-id', fixture: false });
      }
      return binding;
    },
    send: async (repo, task, role, ref) => {
      const round = ++sent;
      request = { protocol: 2, task, role, round, request_id: `fixture-pi-request-${round}`, context_sha256: 'sha256:' + 'a'.repeat(64),
        context_ref: ref, source_ref: ref, result_ref: join(repo, 'fixture-result.json'),
        result_contract: { required_fields: ['request_id', 'context_sha256', 'value'], atomic_write: 'temp_rename' } };
      writeSessionArtifact(join(f.dir, `observed-${round}.json`), { request_id: request.request_id, kind: 'ended', outcome: 'completed', actual_model: actualModel });
      return request;
    },
    collect: async () => {
      const domain = JSON.parse(readFileSync(f.packetPath(request.round), 'utf8').match(/^DOMAIN IDENTITY: (.*)$/m)![1]!);
      return { request_id: request.request_id, context_sha256: request.context_sha256,
        value: { request_id: request.request_id, context_sha256: domain.context_sha256, subject_sha256: domain.subject_sha256,
          verdict, summary: '[fixture opinion; no provider call]', findings: verdict === 'PASS' ? [] : [finding] } };
    } };
  const result = await runReviewRound({ ...f.options, harness: 'pi' }, effects);
  expect(result.status).toBe(example.verdict === 'PASS' ? 'accepted' : 'rejected');
  expect(result.receipt.reviewer).toBe('Pi'); expect(result.receipt.actual_harness).toBe('pi');
  expect(result.receipt.actual_model).toBe(actualModel); expect(result.output.actual_model).toBe(actualModel);
  expect(Object.hasOwn(result.receipt, 'cross_model')).toBe(false);
  expect(result.receipt.model_relation).toBe('unknown');
  const input = { repo_root: f.options.reviewerRepo, binding: binding!, ready_path: join(f.dir, 'ready.json') };
  const native = bindNativeTaskSession(input);
  expect(native.host).toBe('pi'); expect(native.native_session_id).toBe('fixture-pi-native-id');
  expect(bindNativeTaskSession(input)).toEqual(native);
  expect(() => bindNativeTaskSession({ ...input, binding: { ...binding!, max_requests: 2 } })).toThrow('binding_changed');
  if (example.verdict === 'PASS') expect((await verifyAcceptance({ root: f.root, authority: f.authority, authorityHome: f.home })).actual_model).toBe(actualModel);
  const host = readSessionArtifact<{ output: string }>(join(f.dir, 'host.json'));
  const directory = join(host.output, '.pi-agent');
  expectGeneratedPiDirectory(directory);
  const cancel = example.verdict === 'FAIL';
  if (cancel) {
    const priorReceipt = readFileSync(acceptanceReceiptPath(f.root, f.home), 'utf8');
    writeFileSync(join(f.root, 'feature.txt'), 'candidate\n\n'); f.refresh();
    // A null model is valid, so a malformed empty model keeps this failure path.
    actualModel = ''; verdict = 'PASS';
    // The live host keeps its timeout; a later round with a shorter one is refused.
    await expect(runReviewRound({ ...f.options, harness: 'pi', timeoutMs: 1000 }, effects)).rejects.toThrow('review_timeout_changed_for_live_host');
    await expect(runReviewRound({ ...f.options, harness: 'pi' }, effects)).rejects.toThrow('review_actual_model_unverified');
    expect(readFileSync(acceptanceReceiptPath(f.root, f.home), 'utf8')).toBe(priorReceipt);
    expect(existsSync(join(f.dir, 'accepted-2.json'))).toBe(false);
  }
  expect((await closeReview(f.root, f.authority, cancel, f.home, effects)).status).toBe('closed');
  // The generated files hold no credential, so they stay with the output.
  expectGeneratedPiDirectory(directory);
}, 60000);

test('Pi review requires explicit selection and cannot be a missing-provider fallback', async () => {
  const f = packetRoundFixture();
  const { harness: _harness, ...options } = f.options;
  const calls: string[] = [];
  await expect(runReviewRound(options, { ...f.effects, owner: () => 'pi',
    installation: async kind => { calls.push(kind); return kind === 'claude' ? { kind: 'not_found' } : { kind: 'available', via: 'bundled' }; },
  })).rejects.toThrow('review_provider_executable_missing_or_unsupported');
  expect(calls).toEqual(['claude']);
  expect(existsSync(join(f.dir, 'session.json'))).toBe(false);
});

test.each(['herdr-app', 'app-terminal'] as const)('an unready Pi blocks a new Pi %s review before admission', async launch => {
  const f = packetRoundFixture();
  const { endpoint: _endpoint, parentPane: _parentPane, ...terminal } = f.options;
  const options = launch === 'app-terminal' ? { ...terminal, launch } : f.options;
  const blocker = () => 'PI_HOST_UNSUPPORTED_VERSION' as const;
  await expect(runReviewRound({ ...options, harness: 'pi' }, { ...f.effects, piExecutable: () => '/usr/bin/true', piReviewLaunchBlocker: blocker }))
    .rejects.toThrow('review_pi_launch_not_ready: PI_HOST_UNSUPPORTED_VERSION');
  expect(f.calls).toEqual(['installation']);
  expect(existsSync(join(f.dir, 'session.json'))).toBe(false);
});

test('a Claude review does not read Pi readiness', async () => {
  const f = packetRoundFixture();
  // Claude passes the gate position and reaches admission; it fails later on every platform.
  await expect(runReviewRound(f.options, { ...f.effects, piReviewLaunchBlocker: () => { throw new Error('claude must not read Pi readiness'); } }))
    .rejects.not.toThrow('claude must not read Pi readiness');
  expect(f.calls).toContain('admit');
});

type SeamHarness = 'claude' | 'codex' | 'pi';
type ScriptedTurn = NonNullable<Parameters<typeof import('@botiverse/oar/testing').scriptedRuntime>[0]>['turn'];
/** Zero-model host seam: a scripted OAR Session behind the real OarReviewHost.
 * A null model is a runtime that never reported one; OAR's fold stays null. */
async function scriptedSeamHost(kind: SeamHarness, model: string | null, cwd: string, turn?: ScriptedTurn) {
  const { OarReviewHost } = await import('../src/effects/review-runner/task-oar-host');
  const { scriptedRuntime } = await import('@botiverse/oar/testing');
  const session = await scriptedRuntime({ id: kind, ...(model === null ? {} : { model }),
    turn: turn ?? (async ({ say }) => { say('[fixture observation; no provider call]'); }) }).session({ kind: 'available', via: 'bundled' }, { cwd });
  const observed = model === null ? new Proxy(session, { get(target, key) {
    if (key === 'model') return () => ({ ...target.model(), value: null });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : session;
  return new OarReviewHost(observed, () => {});
}

const AUTHOR_ROLE = 'implementer';
const AUTHOR_PANE = offlineTerminalAddress(AUTHOR_ROLE);
/** A bound author task session. Every turn runs through the host seam, which writes its observation file. */
async function authorSession(f: ReturnType<typeof packetRoundFixture>, kind: SeamHarness, models: (string | null)[],
  options: { root?: string; task?: string; authority?: ReviewRoundAuthority } = {}) {
  const spec = { task: options.task ?? 'fixture-author', role: AUTHOR_ROLE, harness_kind: kind, endpoint: f.options.endpoint,
    args: [], max_requests: 3 };
  const repo = options.root ?? f.root;
  const binding = await startOfflineTaskAgent(repo, spec, { source: options.authority ?? f.authority, claim: f.options.taskClaim });
  const dir = taskSessionDirectory(repo, spec.task, spec.role);
  const turn = async (round: number, model: string | null, script?: ScriptedTurn) => {
    const request_id = randomUUID();
    writeSessionArtifact(join(dir, `request-${round}.json`), { protocol: 2, task: spec.task, role: spec.role, round, request_id });
    const host = await scriptedSeamHost(kind, model, dir, script);
    let published!: () => void;
    const running = new Promise<void>(resolve => { published = resolve; });
    const pending = host.prompt(kind, '[fixture author turn]', { request_id, round, host: binding.provider }, snapshot => {
      writeSessionArtifact(join(dir, oarObservationFile(round)), snapshot, false);
      if (snapshot.status === 'running') published();
    }).finally(() => host.dispose());
    return { pending, running };
  };
  for (const [index, model] of models.entries()) await (await turn(index + 1, model)).pending;
  return { binding, dir, turn };
}
type ReviewRoundAuthority = ReturnType<typeof packetRoundFixture>['authority'];

/** One review round whose reviewer observation is written by runHostFileRequest. */
async function seamReview(f: ReturnType<typeof packetRoundFixture>, harness: SeamHarness, reviewerModel: string | null, parentPane = f.options.parentPane) {
  const { mkdirSync } = await import('node:fs');
  const { runHostFileRequest } = await import('../src/effects/review-runner/task-oar-host');
  const hostDir = join(f.home, `seam-host-${harness}`); mkdirSync(hostDir);
  const host = await scriptedSeamHost(harness, reviewerModel, hostDir);
  let binding: TaskPaneBinding | undefined, request: TaskRequest;
  const effects: TaskReviewEffects = { ...f.effects, assertBinding: () => {}, piExecutable: () => '/usr/bin/true',
    installation: async (_kind, executable) => harness === 'pi' ? { kind: 'available', via: 'bundled' }
      : { kind: 'available', via: 'executable', command: executable ?? '/usr/bin/true' },
    start: async (repo, spec, _command, _ready, _guard, authority) => {
      if (!authority) throw new Error('fixture_task_authority_missing');
      binding = await startOfflineTaskAgent(repo, spec, authority);
      writeSessionArtifact(join(f.dir, 'ready.json'), { pid: binding.provider.pid, session_id: host.sessionId, fixture: false });
      return binding;
    },
    send: async (_repo, task, role, _ref, _policy, _delivery, publish) => {
      const content = '[fixture review request]';
      request = { protocol: 2, task, role, round: 1, request_id: randomUUID(), context_ref: join(hostDir, 'context-1.txt'), source_ref: 'fixture',
        result_ref: join(hostDir, 'result-1.json'), context_sha256: 'sha256:' + createHash('sha256').update(content).digest('hex'),
        result_contract: { required_fields: ['request_id', 'context_sha256', 'value'], atomic_write: 'temp_rename' } };
      await publish!(request);
      writeFileSync(request.context_ref, content);
      writeFileSync(join(hostDir, 'started-1.json'), JSON.stringify({ request_id: request.request_id, provider: { pid: process.pid, identity: 'fixture-host' } }));
      await runHostFileRequest(host, { kind: harness, requestDirectory: hostDir, output: hostDir, controlDirectory: f.dir, timeoutMs: 5000 } as unknown as ReviewHostSpec, request);
      return request;
    },
    collect: async () => {
      const domain = JSON.parse(readFileSync(f.packetPath(1), 'utf8').match(/^DOMAIN IDENTITY: (.*)$/m)![1]!);
      return { request_id: request.request_id, context_sha256: request.context_sha256,
        value: { request_id: request.request_id, context_sha256: domain.context_sha256, subject_sha256: domain.subject_sha256,
          verdict: 'PASS', summary: '[fixture opinion; no provider call]', findings: [] } };
    } };
  try {
    const result = await runReviewRound({ ...f.options, parentPane, harness }, effects);
    // The Receipt model is the host-written observation, never a value this test supplied.
    expect(result.receipt.actual_model).toBe(readSessionArtifact<{ actual_model: string | null }>(join(f.dir, 'observed-1.json')).actual_model);
    return result;
  } finally { await host.dispose(); }
}

for (const harness of ['claude', 'codex', 'pi'] as const) darwinTest(`a null ${harness} reviewer model records a Receipt with an unknown model relation`, async () => {
  const { verifyAcceptance } = await import('../src/effects/review/acceptance-receipt');
  const f = packetRoundFixture();
  // Claude: the shared rule writes null for any init model. Codex and Pi: the runtime reported no model.
  const result = await seamReview(f, harness, harness === 'claude' ? 'anthropic/claude-fixture' : null);
  expect(result.status).toBe('accepted');
  expect(result.receipt).toMatchObject({ protocol: 4, actual_harness: harness, actual_model: null,
    author_session_binding_sha256: null, author_actual_models: null, model_relation: 'unknown' });
  expect(result.output.actual_model).toBeNull();
  expect(await verifyAcceptance({ root: f.root, authority: f.authority, authorityHome: f.home })).toEqual(result.receipt);
  expect(readFileSync(result.projection, 'utf8')).toContain('> **Model Relation**: unknown');
}, 60_000);

for (const example of [
  { author: 'codex' as const, models: ['gpt-6.1-sol', 'gpt-6-astra'], reviewer: 'magpie/anthropic/claude-opus-5-5', relation: 'different-family' as const },
  { author: 'pi' as const, models: ['magpie/anthropic/claude-opus-5-5'], reviewer: 'cursor/claude-sonnet-5', relation: 'same-family' as const },
  // A model outside the closed family table cannot prove a difference.
  { author: 'pi' as const, models: ['fixture/unlisted-model'], reviewer: 'magpie/anthropic/claude-opus-5-5', relation: 'unknown' as const },
]) darwinTest(`bound author turn models ${example.models.join(', ')} against reviewer ${example.reviewer} give ${example.relation}`, async () => {
  const { taskBindingSha256 } = await import('../src/effects/terminal/task-session-admission');
  const f = packetRoundFixture();
  const author = await authorSession(f, example.author, example.models);
  const result = await seamReview(f, 'pi', example.reviewer, AUTHOR_PANE);
  expect(result.receipt.actual_model).toBe(example.reviewer);
  expect(result.receipt.author_session_binding_sha256).toBe(taskBindingSha256(author.binding));
  expect(result.receipt.author_actual_models).toEqual([...example.models].sort());
  expect(result.receipt.model_relation).toBe(example.relation);
}, 90_000);

const UNKNOWN_AUTHOR_REVIEWER = 'magpie/anthropic/claude-opus-5-5';
const authorFields = (receipt: AcceptanceReceiptFields) => [receipt.author_session_binding_sha256, receipt.author_actual_models, receipt.model_relation];
type AcceptanceReceiptFields = Pick<Awaited<ReturnType<typeof seamReview>>['receipt'], 'author_session_binding_sha256' | 'author_actual_models' | 'model_relation'>;

darwinTest('author identity is unknown without a binding on the caller pane', async () => {
  const f = packetRoundFixture();
  const author = await authorSession(f, 'codex', ['gpt-6.1-sol']);
  expect(author.binding.terminal_id).toBe(AUTHOR_PANE);
  expect(f.options.parentPane).not.toBe(AUTHOR_PANE);
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER)).receipt)).toEqual([null, null, 'unknown']);
}, 90_000);

darwinTest('author identity is unknown with two bindings on the caller pane', async () => {
  const f = packetRoundFixture();
  const first = await authorSession(f, 'codex', ['gpt-6.1-sol']);
  const second = await authorSession(f, 'codex', ['gpt-6.1-sol'], { task: 'fixture-second-author' });
  expect([first.binding.terminal_id, second.binding.terminal_id]).toEqual([AUTHOR_PANE, AUTHOR_PANE]);
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([null, null, 'unknown']);
}, 90_000);

darwinTest('author identity is unknown when the only binding works in another execution root', async () => {
  const f = packetRoundFixture();
  const other = join(f.home, 'other-root');
  execFileSync('git', ['-C', f.root, 'worktree', 'add', '-qb', 'other-author-root', other]);
  const author = await authorSession(f, 'codex', ['gpt-6.1-sol'], { root: realpathSync(other) });
  expect([author.binding.terminal_id, author.binding.task_admission?.identity.campaign_sha256]).toEqual([AUTHOR_PANE, f.admissionFixture.admission.campaign_sha256]);
  expect(author.binding.execution_root).toBe(realpathSync(other));
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([null, null, 'unknown']);
}, 90_000);

darwinTest('author identity is unknown when the only binding belongs to another campaign', async () => {
  const f = packetRoundFixture();
  const admission = f.admissionFixture.admission;
  const other = seedReviewAdmissionFixture(f.root, f.home, { reviewer: admission.policy.reviewer, userWaiver: 'forbidden', actor: admission.actor_id,
    allowedPaths: [...admission.allowed_paths], oracles: [...admission.oracles], plan: JSON.parse(JSON.stringify(admission.verification_plan)), campaignId: 'other-campaign' });
  const author = await authorSession(f, 'codex', ['gpt-6.1-sol'], { authority: { ...f.authority, ...other.source } });
  expect([author.binding.terminal_id, author.binding.execution_root]).toEqual([AUTHOR_PANE, realpathSync(f.root)]);
  expect(author.binding.task_admission?.identity.campaign_sha256).toBe(other.admission.campaign_sha256);
  expect(other.admission.campaign_sha256).not.toBe(f.admissionFixture.admission.campaign_sha256);
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([null, null, 'unknown']);
}, 90_000);

darwinTest('author models are unknown when one Claude turn has no observed model', async () => {
  const { taskBindingSha256 } = await import('../src/effects/terminal/task-session-admission');
  const f = packetRoundFixture();
  const author = await authorSession(f, 'claude', ['anthropic/claude-opus-5-5']);
  // The shared rule: the Claude host writes null for any init model.
  expect(readSessionArtifact<OarObservationSnapshot>(join(author.dir, oarObservationFile(1))).actual_model).toBeNull();
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([taskBindingSha256(author.binding), null, 'unknown']);
}, 90_000);

darwinTest('author models are unknown when one author turn has a protocol-2 observation', async () => {
  const { taskBindingSha256 } = await import('../src/effects/terminal/task-session-admission');
  const f = packetRoundFixture();
  const author = await authorSession(f, 'codex', ['gpt-6.1-sol', 'gpt-6.1-sol']);
  // An observation written before the v3 upgrade has no actual_model field.
  const path = join(author.dir, oarObservationFile(2));
  const { actual_model: _model, ...legacy } = readSessionArtifact<OarObservationSnapshot>(path);
  writeFileSync(path, JSON.stringify({ ...legacy, protocol: 'repo-harness.oar-observation.v2' }));
  expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([taskBindingSha256(author.binding), null, 'unknown']);
}, 90_000);

darwinTest('author models are unknown while one author turn is running', async () => {
  const { taskBindingSha256 } = await import('../src/effects/terminal/task-session-admission');
  const f = packetRoundFixture();
  const author = await authorSession(f, 'codex', ['gpt-6.1-sol']);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turn = await author.turn(2, 'gpt-6.1-sol', async ({ tool }) => { await tool('Read', 'fixture', async () => { await gate; return 'fixture'; }); });
  try {
    // The host published a running observation for this turn.
    await turn.running;
    expect(readSessionArtifact<OarObservationSnapshot>(join(author.dir, oarObservationFile(2))).status).toBe('running');
    expect(authorFields((await seamReview(f, 'pi', UNKNOWN_AUTHOR_REVIEWER, AUTHOR_PANE)).receipt)).toEqual([taskBindingSha256(author.binding), null, 'unknown']);
  } finally { release(); await turn.pending; }
  expect(readSessionArtifact<OarObservationSnapshot>(join(author.dir, oarObservationFile(2))).actual_model).toBe('gpt-6.1-sol');
}, 90_000);

for (const harness of ['codex', 'pi'] as const) darwinTest(`an unreachable magpie refuses the ${harness} round before any launch, with no native credential`, async () => {
  const f = packetRoundFixture();
  const native = join(f.options.endpoint.home, harness === 'codex' ? '.codex' : '.pi/agent');
  mkdirSync(native, { recursive: true }); writeFileSync(join(native, 'auth.json'), '{"fixture":"sk-PROBE-LITERAL"}');
  const refusal = 'review_magpie_unreachable: http://127.0.0.1:3425/v1 does not answer; start magpie, then repeat the round';
  await expect(runReviewRound({ ...f.options, harness }, { ...f.effects, piExecutable: () => '/usr/bin/true',
    installation: async (_kind, executable) => harness === 'pi' ? { kind: 'available', via: 'bundled' } : { kind: 'available', via: 'executable', command: executable ?? '/usr/bin/true' },
    assertMagpieReachable: async () => { throw new Error(refusal); } })).rejects.toThrow(refusal);
  expect(f.calls).not.toContain('start');
  expect(existsSync(join(f.dir, 'launch-deadline.json'))).toBe(false);
  const { output } = readSessionArtifact<{ output: string }>(join(f.dir, 'host.json'));
  if (harness === 'codex') {
    expect(readdirSync(join(output, '.codex-home'))).toEqual(['config.toml']);
    expect(readFileSync(join(output, '.codex-home/config.toml'), 'utf8')).toBe(MAGPIE_CODEX_CONFIG);
  } else expectGeneratedPiDirectory(join(output, '.pi-agent'));
  expectNoStoredPiProbe(output);
}, 60_000);

// The profile comes from runReviewRound, so each case proves the path that its reviewer uses.
for (const harness of ['codex', 'claude', 'pi'] as const) darwinTest(`zero-model probe through the ${harness} launcher: loopback is denied against live listeners and only the magpie port connects for codex and pi`, async () => {
  const f = packetRoundFixture();
  const listen = (hostname: string, port = 0) => Bun.listen({ hostname, port, socket: { data() {} } });
  const v4 = listen('127.0.0.1'), v6 = listen('::1'), other = listen('127.0.0.1');
  // A running magpie already holds its port; otherwise this listener stands in for it.
  let magpie: ReturnType<typeof listen> | undefined;
  try { magpie = listen('127.0.0.1', 3425); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  try {
    const expected = { [`::1 ${v6.port}`]: 'denied', [`127.0.0.1 ${v4.port}`]: 'denied', [`::ffff:127.0.0.1 ${v4.port}`]: 'denied',
      [`127.0.0.1 ${other.port}`]: 'denied', '127.0.0.1 3425': harness === 'claude' ? 'denied' : 'allowed' };
    for (const target of Object.keys(expected)) expect(spawnSync('/usr/bin/nc', ['-z', '-G', '2', ...target.split(' ')]).status, target).toBe(0);
    const vendor = join(f.home, `fake-${harness}`);
    writeFileSync(vendor, `#!/bin/sh\n${Object.keys(expected).map(target => `if /usr/bin/nc -z -G 2 ${target} >/dev/null 2>&1; then echo '${target} allowed'; else echo '${target} denied'; fi`).join('\n')}\n`);
    chmodSync(vendor, 0o700);
    await expect(runReviewRound({ ...f.options, harness }, { ...f.effects, piExecutable: () => vendor,
      installation: async (_kind, executable) => harness === 'pi' ? { kind: 'available', via: 'bundled' } : { kind: 'available', via: 'executable', command: executable ?? vendor },
      start: async () => { throw new Error('fixture_start_failure'); } })).rejects.toThrow('fixture_start_failure');
    const { launcher } = readSessionArtifact<{ launcher: string }>(join(f.dir, 'host.json'));
    expect(execFileSync(launcher, [], { encoding: 'utf8', timeout: 20_000 }).trim().split('\n')).toEqual(Object.entries(expected).map(([target, access]) => `${target} ${access}`));
  } finally { for (const listener of [v4, v6, other, magpie]) listener?.stop(true); }
}, 90_000);

// Mandatory B first proof. Dummy Node processes only; no OAR/vendor Session.
darwinTest('OAR isolation: Seatbelt denies paired host and descendant writes with output-only allowance', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { reviewIsolationPolicy, reviewHostTemporaryDirectory } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('oar-isolation'); roots.push(root);
  const subject = join(root, 'subject'), primary = join(root, 'primary'), owner = join(root, 'owner-record'), journal = join(root, 'journal'), git = join(root, 'git-common'), output = join(root, 'output');
  for (const dir of [subject, primary, owner, journal, git, output]) mkdirSync(dir);
  const protectedPaths = [subject, primary, owner, journal, git].map(dir => join(dir, 'protected.txt'));
  for (const path of protectedPaths) writeFileSync(path, 'KEEP');
  symlinkSync(protectedPaths[0]!, join(output, 'escape-link'));
  const forbidden = ['CLAUDE.md','AGENTS.md','settings.local.json','auth.json','.credentials.json','config.toml','agents/definition.md','skills/definition.md','rules/definition.md','plugins/definition.json','hooks/handler.sh'].map(path => join(output, path));
  for (const path of forbidden) { const { dirname } = await import('node:path'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'KEEP'); }
  const nativeHome = join(root, 'native-home'); mkdirSync(join(nativeHome, '.codex', 'tmp'), { recursive: true }); mkdirSync(join(nativeHome, '.codex', 'thread-writer-locks'));
  const isolated = join(output, '.codex-home'); mkdirSync(isolated, { mode: 0o700 });
  const allowedNative = [join(isolated,'state_5.sqlite'),join(isolated,'cache.txt')];
  const deniedNative = ['state_5.sqlite','state_5.sqlite-wal','state_5.sqlite-shm','logs_2.sqlite','logs_2.sqlite-wal','logs_2.sqlite-shm','goals_1.sqlite','memories_1.sqlite','queue_1.sqlite','installation_id','tmp/state','thread-writer-locks/lock','config.toml','auth.json','AGENTS.md','rules/rule.md','skills/skill.md','other-state.json'].map(path => join(nativeHome, '.codex', path));
  const isolatedDenied = [join(isolated,'auth.json'),join(isolated,'config.toml')];
  for (const path of [...allowedNative, ...deniedNative, ...isolatedDenied]) { const { dirname } = await import('node:path'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'KEEP'); }
  const targets = [...protectedPaths, join(output, 'escape-link'), join(output, '../subject/protected.txt'), ...forbidden, ...deniedNative, ...isolatedDenied];
  const policy = reviewIsolationPolicy({ subject, primary, ownerRecord: owner, journal, gitCommonDir: git, output });
  expect(policy).not.toContain(nativeHome);
  const profile = join(root, 'profile.sb'); writeFileSync(profile, policy);
  const worker = join(root, 'worker.cjs');
  writeFileSync(worker, `
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),os=require('node:os');
const spec=JSON.parse(process.argv[2]);
const results=spec.targets.map(path=>{try{fs.writeFileSync(path,'CHANGED');return {path,denied:false}}catch(e){return {path,denied:true,code:e.code,message:e.message}}});
const capture=r=>({status:r.status,error:r.error?.code,message:r.error?.message,stdout:r.stdout,stderr:r.stderr});
const stdioIgnore=capture(cp.spawnSync('/usr/bin/true',[],{stdio:'ignore'}));
const devNull=capture(cp.spawnSync('/bin/sh',['-c','echo hi > /dev/null'],{encoding:'utf8'}));
let temporary;try{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oar-zero-'));fs.writeFileSync(path.join(dir,'check.txt'),'TMP');temporary={ok:true,dir}}catch(e){temporary={ok:false,code:e.code,message:e.message}};
const nested=capture(cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/usr/bin/true'],{encoding:'utf8'}));
const nativeWrites=spec.allowedNative.map(path=>{try{fs.writeFileSync(path,'NATIVE');return {path,allowed:true}}catch(e){return {path,allowed:false,code:e.code,message:e.message}}});
const operations={stdioIgnore,devNull,temporary,nested,nativeWrites};
fs.writeFileSync(spec.allowed,'ALLOWED');
if(spec.child){const r=cp.spawnSync(process.execPath,[__filename,JSON.stringify({...spec,child:false,allowed:spec.childAllowed})],{encoding:'utf8'});console.log(JSON.stringify({results,operations,child:{status:r.status,stdout:r.stdout,stderr:r.stderr}}))}
else console.log(JSON.stringify({results,operations}));
`);
  const node = resolveNode24();
  const spec = { targets, allowedNative, allowed: join(output, 'host.txt'), childAllowed: join(output, 'child.txt'), child: true };
  const temporary = reviewHostTemporaryDirectory(output);
  const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, node, worker, JSON.stringify(spec)], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TMPDIR: temporary } });
  console.log(JSON.stringify({ diagnostic: 'zero-model Seatbelt fixture', status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }));
  expect(result.status, result.stderr).toBe(0);
  const observed = JSON.parse(result.stdout);
  expect(observed.results).toHaveLength(targets.length);
  expect(Number(observed.child.status), String(observed.child.stderr)).toBe(0);
  const child = JSON.parse(observed.child.stdout);
  for (const row of [...observed.results, ...child.results]) {
    expect(Boolean(row.denied), String(row.path)).toBe(true);
    expect(['EPERM', 'EACCES'], row.path).toContain(row.code);
  }
  for (const evidence of [observed, child]) {
    for (const result of evidence.operations.nativeWrites) expect(Boolean(result.allowed), String(result.path)).toBe(true);
    expect(evidence.operations.stdioIgnore.status).toBe(0);
    expect(evidence.operations.devNull.status).toBe(0);
    expect(evidence.operations.temporary.ok).toBe(true);
    expect(String(evidence.operations.temporary.dir).startsWith(temporary + '/')).toBe(true);
    // Nested Seatbelt remains unusable; OAR defaults avoid nesting. Not a
    // native Codex exec proof or an instruction to weaken the outer policy.
    expect(evidence.operations.nested.status).toBe(71);
    expect(String(evidence.operations.nested.stderr)).toContain('sandbox_apply: Operation not permitted');
  }
  for (const path of [...protectedPaths, ...forbidden, ...deniedNative, ...isolatedDenied]) expect(readFileSync(path, 'utf8')).toBe('KEEP');
  expect(readFileSync(join(output, 'host.txt'), 'utf8')).toBe('ALLOWED');
  expect(readFileSync(join(output, 'child.txt'), 'utf8')).toBe('ALLOWED');
});

darwinTest('OAR isolation: system DNS works while a reachable local Unix socket stays denied', async () => {
  const { createServer } = await import('node:net');
  const { mkdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { reviewIsolationPolicy } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('oar-dns-isolation'); roots.push(root);
  const subject = join(root, 'subject'), output = join(root, 'output');
  mkdirSync(subject); mkdirSync(output);
  const socketPath = join(root, 'control.sock');
  const server = createServer(socket => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const node = resolveNode24();
    const script = `const net=require('node:net'),dns=require('node:dns');
const connect=()=>new Promise(resolve=>{const socket=net.createConnection(process.argv[1]);socket.once('connect',()=>{socket.destroy();resolve({connected:true})});socket.once('error',error=>resolve({connected:false,code:error.code}));});
(async()=>{const local=await connect();const lookup=await new Promise(resolve=>dns.lookup('example.com',error=>resolve({resolved:!error,code:error?.code??null})));console.log(JSON.stringify({local,lookup}));})();`;
    const control = spawnSync(node, ['-e', script, socketPath], { encoding: 'utf8', timeout: 15000 });
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toMatchObject({ local: { connected: true }, lookup: { resolved: true } });
    const profile = join(root, 'profile.sb');
    writeFileSync(profile, reviewIsolationPolicy({ subject, primary: subject, ownerRecord: subject,
      journal: subject, gitCommonDir: subject, output }));
    const confined = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, node, '-e', script, socketPath], { encoding: 'utf8', timeout: 15000 });
    expect(confined.status, confined.stderr).toBe(0);
    const result = JSON.parse(confined.stdout);
    expect(result.local.connected).toBe(false);
    expect(['EPERM', 'EACCES']).toContain(result.local.code);
    expect(result.lookup).toEqual({ resolved: true, code: null });
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
});

test('OAR isolation: reject authority overlap and symlink output roots before execution', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const { reviewIsolationPolicy } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('oar-isolation-admission'); roots.push(root);
  const subject = join(root, 'subject'), primary = join(root, 'primary'), output = join(root, 'output');
  for (const path of [subject, primary, output]) mkdirSync(path);
  const spec = { subject, primary, ownerRecord: primary, journal: primary, gitCommonDir: primary, output };
  expect(() => reviewIsolationPolicy({ ...spec, output: primary })).toThrow('OVERLAPS_AUTHORITY');
  const link = join(root, 'link'); symlinkSync(output, link);
  expect(() => reviewIsolationPolicy({ ...spec, output: link })).toThrow('OUTPUT_UNSAFE');
  expect(() => reviewIsolationPolicy(spec, 'win32')).toThrow('UNSUPPORTED_PLATFORM');
  // The read rule (#1721) applies only to the cleanup caller; a read root must not overlap output or be a link.
  // The policy text is the same on every host; only its enforcement needs macOS.
  expect(reviewIsolationPolicy(spec, 'darwin')).not.toMatch(/file-read/u);
  expect(reviewIsolationPolicy(spec, 'darwin').endsWith('(deny network-outbound (remote tcp4 "localhost:*"))\n(deny network-outbound (remote tcp6 "*:*"))\n')).toBe(true);
  const target = realpathSync(subject);
  expect(reviewIsolationPolicy({ ...spec, cleanup: { readDenied: [target] } }, 'darwin')).toBe(`${reviewIsolationPolicy(spec, 'darwin')}(deny file-read* (subpath ${JSON.stringify(target)}))\n`);
  expect(() => reviewIsolationPolicy({ ...spec, cleanup: { readDenied: [root] } })).toThrow('OVERLAPS_AUTHORITY');
  const subjectLink = join(root, 'subject-link'); symlinkSync(subject, subjectLink);
  expect(() => reviewIsolationPolicy({ ...spec, cleanup: { readDenied: [subjectLink] } })).toThrow('PROTECTED_PATH_UNSAFE');
});

async function runOarNodeFixture(label: string, body: string, confined = true, during?: (output: string, pid: number) => Promise<void>) {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { spawn, spawnSync } = await import('node:child_process');
  const { reviewIsolationPolicy, reviewHostTemporaryDirectory } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace(label); roots.push(root);
  const subject = join(root, 'subject'), output = join(root, 'output'); mkdirSync(subject); mkdirSync(output);
  const paths = { subject, primary: subject, ownerRecord: subject, journal: subject, gitCommonDir: subject, output };
  const policyFile = join(root, 'profile.sb'); writeFileSync(policyFile, reviewIsolationPolicy(paths), { mode: 0o600 });
  const temporary = reviewHostTemporaryDirectory(output), worker = join(root, 'fixture.mjs');
  const entry = pathToFileURL(realpathSync(join(import.meta.dir, '../dist/oar-review-host.js'))).href;
  writeFileSync(worker, `import assert from 'node:assert/strict';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openScriptedReviewHost,runHostFileRequest,serveHostFileRequests,reviewRuntime,assertOarHostNode} from ${JSON.stringify(entry)};
const output=${JSON.stringify(output)},isolation=${JSON.stringify({paths,policyFile})};
${body}`);
  const node = resolveNode24();
  // `during` writes files from this process while the worker runs, so the worker must not block the event loop.
  const result = during ? await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', policyFile, node, worker], { env: { ...process.env, TMPDIR: temporary } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    during(output, child.pid!).catch(error => { child.kill('SIGKILL'); reject(error); });
  }) : confined ? spawnSync('/usr/bin/sandbox-exec', ['-f', policyFile, node, worker], { encoding: 'utf8', timeout: 15000, env: { ...process.env, TMPDIR: temporary } })
    : spawnSync(node, [worker], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { calls: number; passed: boolean; model: string | null };
}

darwinTest('OAR scripted host: Node Session budget, default sandbox knob and disposal under admission', async () => {
  const result = await runOarNodeFixture('oar-scripted-node', `
let calls=0;const events=[];process.env.OAR_CODEX_SANDBOX='workspace-write';
const host=await openScriptedReviewHost({cwd:output},v=>events.push(v),async({say})=>{assert.equal(process.env.OAR_CODEX_SANDBOX,undefined);calls++;say('RECOMMENDATION: fixture observation only — confidence: HIGH')},isolation);
try{const id=host.sessionId;for(const [index,input] of ['one','two','three'].entries()){assert.equal((await host.prompt('codex',input,{request_id:'11111111-1111-4111-8111-'+String(index+1).padStart(12,'0'),round:index+1,host:{pid:process.pid,identity:'fixture-host'}},()=>{})).kind,'ended');assert.equal(host.sessionId,id)}
assert.equal(calls,3);assert.ok(events.length>0);await assert.rejects(host.prompt('codex','fourth',{request_id:'fourth',round:4,host:{pid:process.pid,identity:'fixture-host'}},()=>{}),/BUDGET_EXHAUSTED/);
await host.dispose();await assert.rejects(host.prompt('codex','after-dispose',{request_id:'after-dispose',round:4,host:{pid:process.pid,identity:'fixture-host'}},()=>{}),/HOST_DISPOSED/);
assert.equal(reviewRuntime('claude').id,'claude');assert.equal(reviewRuntime('codex').id,'codex');assert.throws(()=>reviewRuntime('grok'),/UNSUPPORTED/);assert.throws(()=>assertOarHostNode('22.22.0'),/NODE_24_REQUIRED/);
console.log(JSON.stringify({calls,passed:true}));}finally{await host.dispose()}`);
  expect(result.calls).toBe(3); expect(result.passed).toBe(true);
});

darwinTest('OAR file delivery: Node reviewer writes Results, recommendation text is observation', async () => {
  const result = await runOarNodeFixture('oar-file-node', String.raw`
const spec={mode:'review',kind:'codex',installation:{kind:'available',via:'bundled'},options:{cwd:output},requestDirectory:output,output,controlDirectory:output,timeoutMs:1000,isolation};let calls=0;
const host=await openScriptedReviewHost(spec.options,()=>{},async({input,say})=>{calls++;const request=JSON.parse(input.split('\n')[0].slice('TASK REQUEST: '.length));say('RECOMMENDATION: fixture file communication — confidence: HIGH');writeFileSync(request.result_ref,JSON.stringify({request_id:request.request_id,context_sha256:request.context_sha256,value:{fixture:true,verdict:'FAIL',summary:'[fixture opinion] revise'}}))},isolation);
try{const id=host.sessionId;for(let round=1;round<=3;round++){const content='Domain-shaped fixture '+round;const request={protocol:2,task:'fixture',role:'deep-reasoner',round,request_id:'11111111-1111-4111-8111-'+String(round).padStart(12,'0'),context_ref:join(output,'context-'+round+'.txt'),source_ref:'fixture',result_ref:join(output,'result-'+round+'.json'),context_sha256:'sha256:'+createHash('sha256').update(content).digest('hex'),result_contract:{required_fields:['request_id','context_sha256','value'],atomic_write:'temp_rename'}};writeFileSync(join(output,'deadline-'+round+'.json'),JSON.stringify({request_id:request.request_id,deadline:Date.now()+spec.timeoutMs}));writeFileSync(request.context_ref,content);writeFileSync(join(output,'started-'+round+'.json'),JSON.stringify({request_id:request.request_id,provider:{pid:process.pid,identity:'fixture-host'}}));const observed=await runHostFileRequest(host,spec,request);const capture=JSON.parse(readFileSync(join(output,'oar-observation-'+round+'.json'),'utf8'));assert.equal(capture.request_id,request.request_id);assert.equal(capture.session_id,id);assert.equal(capture.host.pid,process.pid);assert.equal(capture.input_id,request.request_id);assert.equal(Object.hasOwn(capture,'records'),false);assert.equal(observed.kind,'ended');assert.equal(observed.actual_model,'fixture-oar');assert.equal(capture.protocol,'repo-harness.oar-observation.v3');assert.equal(capture.actual_model,observed.actual_model);assert.equal(host.sessionId,id);assert.equal(JSON.parse(readFileSync(request.result_ref,'utf8')).value.summary,'[fixture opinion] revise')}
assert.equal(calls,3);await assert.rejects(host.prompt('codex','fourth',{request_id:'fourth',round:4,host:{pid:process.pid,identity:'fixture-host'}},()=>{}),/BUDGET_EXHAUSTED/);assert.equal(host.model('claude'),null);console.log(JSON.stringify({calls,passed:true,model:host.model('claude')}));}finally{await host.dispose()}`);
  expect(result.calls).toBe(3); expect(result.model).toBeNull();
});

darwinTest('OAR host: a close request during a pending turn aborts that turn and disposes the Session', async () => {
  const result = await runOarNodeFixture('oar-cancel-pending', String.raw`
const spec={mode:'review',kind:'codex',installation:{kind:'available',via:'bundled'},options:{cwd:output},requestDirectory:output,output,controlDirectory:output,timeoutMs:10000,isolation};let calls=0;
// The turn never ends by itself; only Session disposal can settle it.
const host=await openScriptedReviewHost(spec.options,()=>{},async({signal})=>{calls++;writeFileSync(join(output,'turn-started'),'1');await new Promise(resolve=>signal.addEventListener('abort',resolve))},isolation);
let closing;const close=()=>closing??=host.dispose();
try{const content='pending turn';writeFileSync(join(output,'context-1.txt'),content);
const request={protocol:2,task:'fixture',role:'deep-reasoner',round:1,request_id:'11111111-1111-4111-8111-111111111111',context_ref:join(output,'context-1.txt'),source_ref:'fixture',result_ref:join(output,'result-1.json'),context_sha256:'sha256:'+createHash('sha256').update(content).digest('hex'),result_contract:{required_fields:['request_id','context_sha256','value'],atomic_write:'temp_rename'}};
writeFileSync(join(output,'request-1.json'),JSON.stringify(request));writeFileSync(join(output,'deadline-1.json'),JSON.stringify({request_id:request.request_id,deadline:Date.now()+spec.timeoutMs}));writeFileSync(join(output,'started-1.json'),JSON.stringify({request_id:request.request_id,provider:{pid:process.pid,identity:'fixture-host'}}));
const served=serveHostFileRequests(host,spec,close,()=>closing!==undefined,()=>{});
while(!existsSync(join(output,'turn-started')))await new Promise(resolve=>setTimeout(resolve,10));
writeFileSync(join(output,'close.request'),JSON.stringify({close:true}));
await served;await close();
assert.equal(JSON.parse(readFileSync(join(output,'observed-1.json'),'utf8')).outcome,'aborted');assert.equal(existsSync(request.result_ref),false);
await assert.rejects(host.prompt('codex','after-cancel',{request_id:'after-cancel',round:2,host:{pid:process.pid,identity:'fixture-host'}},()=>{}),/HOST_DISPOSED/);
console.log(JSON.stringify({calls,passed:true,model:null}));}finally{await close()}`);
  expect(result.calls).toBe(1); expect(result.passed).toBe(true);
});

test.each(['turn', 'start', 'stuck disposal'] as const)('OAR host: at the round deadline the native pi tree is gone (pending %s)', async stage => {
  const { pathToFileURL } = await import('node:url');
  const root = tmpWorkspace(`oar-deadline-stop-${stage}`); roots.push(root);
  const agent = join(root, 'agent'), work = join(root, 'preflight.log'), pids = join(root, 'pids.json'), fixture = join(root, 'fixture-pi.cjs');
  const spawner = join(root, 'spawner.cjs'), spawned = join(root, 'spawned.log');
  mkdirSync(agent);
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'fixture-key-no-provider-call' } }));
  writeFileSync(join(agent, 'settings.json'), '{"defaultProvider":"openai","defaultModel":"gpt-4o"}');
  const node = resolveNode24(), piCli = realpathSync(join(import.meta.dir, '../node_modules/@earendil-works/pi-coding-agent/dist/cli.js'));
  // A descendant in its own process group that starts a new process group every 5 ms: a recorded tree misses the latest ones.
  writeFileSync(spawner, `const cp=require('node:child_process'),fs=require('node:fs');let n=0;
const timer=setInterval(()=>{if(++n>400)return clearInterval(timer);fs.appendFileSync(${JSON.stringify(spawned)},cp.spawn('/bin/sleep',['1000'],{detached:true,stdio:'ignore'}).pid+'\\n')},5);`);
  // The native pi never acknowledges the prompt (turn) or the get_state request (start). It starts a
  // credential-using preflight descendant that writes a timestamp every 20 ms and the spawner, and it ignores stdin EOF and SIGTERM.
  writeFileSync(fixture, `#!${node}
const cp=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');
const argv=process.argv.slice(2);
const pi=cp.spawn(process.execPath,[${JSON.stringify(piCli)},...argv],{stdio:argv.includes('--version')?'inherit':['pipe','inherit','inherit',3]});
pi.on('exit',code=>process.exit(code??1));
if(!argv.includes('--version')){process.on('SIGTERM',()=>{});
readline.createInterface({input:process.stdin}).on('line',line=>{let type;try{type=JSON.parse(line).type}catch{}
if(type!==${JSON.stringify(stage === 'start' ? 'get_state' : 'prompt')}){pi.stdin.write(line+'\\n');return}
const preflight=cp.spawn(process.execPath,['-e','setInterval(()=>require("node:fs").appendFileSync(${JSON.stringify(work)},Date.now()+"\\\\n"),20)'],{stdio:'ignore'});
const group=cp.spawn(process.execPath,[${JSON.stringify(spawner)}],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,pi.pid,preflight.pid,group.pid]));}).on('close',()=>{});}
`); chmodSync(fixture, 0o700);
  const entry = pathToFileURL(realpathSync(join(import.meta.dir, '../dist/oar-review-host.js'))).href;
  const worker = join(root, 'deadline.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {reviewRuntime,OarReviewHost,runHostFileRequest,openNativeSession} from ${JSON.stringify(entry)};
const dir=${JSON.stringify(root)},agent=${JSON.stringify(agent)};
const options={cwd:dir,model:'openai/gpt-4o',env:{PI_CODING_AGENT_DIR:agent,OAR_PI_AGENT_DIR:agent}};
let deadline,observed;
if(${JSON.stringify(stage)}==='start'){
// Hold the deadline timer until the native tree is ready and the start is still pending.
const controlledDeadline={valueOf:()=>deadline??Date.now()+2140000000},realSetTimeout=globalThis.setTimeout;let fire,settled=false,msCaptured,expected;
globalThis.setTimeout=(fn,ms,...args)=>{if(ms>2000000000){msCaptured=ms;expected=Number(controlledDeadline)-Date.now();fire=()=>fn(...args);return realSetTimeout(()=>{},2140000000)}return realSetTimeout(fn,ms,...args)};
const opening=openNativeSession(reviewRuntime('pi',${JSON.stringify(fixture)}),{kind:'available',via:'bundled'},options,controlledDeadline);
globalThis.setTimeout=realSetTimeout;opening.then(()=>{settled=true},()=>{settled=true});
while(!existsSync(${JSON.stringify(pids)})||!existsSync(${JSON.stringify(work)})||!existsSync(${JSON.stringify(spawned)})){if(settled)throw new Error('native start settled before tree was ready');await new Promise(resolve=>realSetTimeout(resolve,10))}
if(settled||!fire)throw new Error('native start or deadline timer was not pending');
if(Math.abs(msCaptured-expected)>1000)throw new Error('deadline delay '+msCaptured+' differs from expected '+expected);
deadline=Date.now();fire();observed=await opening.catch(error=>String(error));}
else{const host=new OarReviewHost(await reviewRuntime('pi',${JSON.stringify(fixture)}).session({kind:'available',via:'bundled'},options),()=>{});
if(${JSON.stringify(stage)}==='stuck disposal')host.dispose=()=>new Promise(()=>{});
const content='[fixture pending ack]',request={protocol:2,task:'fixture',role:'deep-reasoner',round:1,request_id:randomUUID(),context_ref:join(dir,'context-1.txt'),source_ref:'fixture',result_ref:join(dir,'result-1.json'),context_sha256:'sha256:'+createHash('sha256').update(content).digest('hex'),result_contract:{required_fields:['request_id','context_sha256','value'],atomic_write:'temp_rename'}};
writeFileSync(request.context_ref,content);
writeFileSync(join(dir,'started-1.json'),JSON.stringify({request_id:request.request_id,provider:{pid:process.pid,identity:'fixture-host'}}));
deadline=Date.now()+1500;writeFileSync(join(dir,'deadline-1.json'),JSON.stringify({request_id:request.request_id,deadline}));
observed=await runHostFileRequest(host,{kind:'pi',requestDirectory:dir,output:dir,controlDirectory:dir,timeoutMs:1500},request).catch(error=>String(error));
observed={observed,stopIncomplete:host.stopIncomplete,record:existsSync(join(dir,'observed-1.json'))};}
const returned=Date.now(),alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const tree=JSON.parse(readFileSync(${JSON.stringify(pids)},'utf8')).map(alive);
const escaped=readFileSync(${JSON.stringify(spawned)},'utf8').trim().split('\\n').map(Number).filter(alive);
for(const pid of escaped)process.kill(pid,'SIGKILL');
await new Promise(resolve=>setTimeout(resolve,300));
const last=Math.max(...readFileSync(${JSON.stringify(work)},'utf8').trim().split('\\n').map(Number));
console.log(JSON.stringify({observed,returnedAfter:returned-deadline,lastWorkAfter:last-deadline,tree,escaped:escaped.length,result:existsSync(join(dir,'result-1.json')),grace:process.env.OAR_KILL_GRACE_MS??null}));
process.exit(0);
`);
  const result = spawnSync(node, [worker], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: root } });
  expect(result.status, result.stderr).toBe(0);
  const run = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  expect(run.observed).toEqual({
    turn: { observed: { request_id: expect.any(String), kind: 'deadline_stop', outcome: null, actual_model: null }, stopIncomplete: false, record: true },
    start: expect.stringContaining('OAR_HOST_DEADLINE_STOP: the round deadline passed during the native session start'),
    // The stop is bounded from the deadline: no round record, and main writes no disposal receipt.
    'stuck disposal': { observed: expect.stringContaining('OAR_HOST_DEADLINE_STOP_INCOMPLETE'), stopIncomplete: true, record: false },
  }[stage]);
  // The host returned only after the wrapper, pi, the preflight, the spawner and each process group that it started exited.
  expect(run.tree).toEqual([false, false, false, false]);
  expect(run.escaped).toBe(0);
  expect(run.returnedAfter).toBeGreaterThanOrEqual(stage === 'stuck disposal' ? 5000 : 0); expect(run.returnedAfter).toBeLessThan(stage === 'stuck disposal' ? 6000 : 1000);
  expect(run.lastWorkAfter).toBeLessThan(500);
  expect(run.result).toBe(false);
  // The zero kill grace belongs to the stop only.
  expect(run.grace).toBeNull();
}, 60000);

darwinTest('OAR host: a request without started-N.json is partial; no read, no ack until it is published', async () => {
  const result = await runOarNodeFixture('oar-partial-request', String.raw`
const spec={mode:'review',kind:'codex',installation:{kind:'available',via:'bundled'},options:{cwd:output},requestDirectory:output,output,controlDirectory:output,timeoutMs:5000,isolation};let calls=0;
const host=await openScriptedReviewHost(spec.options,()=>{},async({say})=>{calls++;say('RECOMMENDATION: fixture observation only — confidence: HIGH')},isolation);
let closing,thrown;const close=()=>closing??=host.dispose();const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
const ack=join(output,'ack-1.json'),started=join(output,'started-1.json'),observed=join(output,'observed-1.json');
const served=serveHostFileRequests(host,spec,close,()=>closing!==undefined,()=>{}).catch(error=>{thrown=error});
writeFileSync(join(output,'serving'),'1');
let partialChecks=0;
for(const end=Date.now()+8000;!existsSync(observed)&&thrown===undefined&&Date.now()<end;await sleep(10)){
  const acked=existsSync(ack);
  if(!existsSync(started)){assert.equal(acked,false);if(existsSync(join(output,'request-1.json'))){partialChecks++;if(!existsSync(join(output,'partial-observed')))writeFileSync(join(output,'partial-observed'),'1')}}
}
assert.equal(thrown,undefined);assert.ok(partialChecks>0);assert.equal(JSON.parse(readFileSync(observed,'utf8')).outcome,'completed');
writeFileSync(join(output,'close.request'),JSON.stringify({close:true}));await served;assert.equal(thrown,undefined);
console.log(JSON.stringify({calls,passed:true,model:null}));}finally{await close()}`, true, async (output, pid) => {
    for (let waited = 0; !existsSync(join(output, 'serving')); waited += 10) {
      if (waited > 10000) throw new Error('host fixture never started serving');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const content = 'half-published request';
    const requestId = '11111111-1111-4111-8111-111111111111';
    const request = { protocol: 2, task: 'fixture', role: 'deep-reasoner', round: 1, request_id: requestId, context_ref: join(output, 'context-1.txt'), source_ref: 'fixture',
      result_ref: join(output, 'result-1.json'), context_sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      result_contract: { required_fields: ['request_id', 'context_sha256', 'value'], atomic_write: 'temp_rename' } };
    // Same order as sendTaskRequest: request, the review deadline at the publication boundary, then context and started.
    writeSessionArtifact(join(output, 'request-1.json'), request);
    writeSessionArtifact(join(output, 'deadline-1.json'), { request_id: requestId, deadline: Date.now() + 30_000 });
    for (let waited = 0; !existsSync(join(output, 'partial-observed')); waited += 10) {
      if (waited > 10000) throw new Error('host fixture never observed the partial request');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(request.context_ref, content);
    writeSessionArtifact(join(output, 'started-1.json'), { request_id: requestId, provider: { pid, identity: 'fixture-host' } });
  });
  expect(result.calls).toBe(1); expect(result.passed).toBe(true);
});

darwinTest('OAR Session refuses unconfined or changed owner profiles before opening', async () => {
  const result = await runOarNodeFixture('oar-unconfined', `
let calls=0;await assert.rejects(openScriptedReviewHost({cwd:output},()=>{},async()=>{calls++},isolation),/SEATBELT_REQUIRED/);assert.equal(calls,0);writeFileSync(isolation.policyFile,'(version 1)(allow default)');await assert.rejects(openScriptedReviewHost({cwd:output},()=>{},async()=>{calls++},isolation),/PROFILE_NOT_ADMITTED/);assert.equal(calls,0);console.log(JSON.stringify({calls,passed:true}))`, false);
  expect(result.calls).toBe(0); expect(result.passed).toBe(true);
});

darwinTest('OAR installation is probed by the fixed Node host, never the Bun controller', async () => {
  const { writeFileSync, chmodSync } = await import('node:fs');
  const probeReviewInstallation = (await import('../src/effects/review-runner/task-review-runner')).taskReviewRunner.installation;
  const root = tmpWorkspace('oar-node-installation'); roots.push(root);
  const trace = join(root, 'parent.txt'), executable = join(root, 'fake-codex');
  writeFileSync(executable, `#!/bin/sh\n/bin/ps -p "$PPID" -o command= >> '${trace}'\nprintf '0.0.0\\n'\n`); chmodSync(executable, 0o700);
  const priorNode = process.env.REPO_HARNESS_NODE_BIN, priorBin = process.env.OAR_CODEX_BIN;
  try {
    process.env.REPO_HARNESS_NODE_BIN = resolveNode24();
    process.env.OAR_CODEX_BIN = executable;
    const observed = await probeReviewInstallation('codex');
    expect(observed.kind).toBe('available');
    if (observed.kind !== 'available' || observed.via !== 'executable') throw new Error('fixture installation not observed');
    expect(observed.command).toBe(executable);
    expect(readFileSync(trace, 'utf8')).toContain(process.env.REPO_HARNESS_NODE_BIN);
    expect(readFileSync(trace, 'utf8')).toContain('oar-review-host.js --installation codex');
    expect(readFileSync(trace, 'utf8')).not.toContain('bun ');
    const source = readFileSync(join(import.meta.dir, '../src/effects/review/generic-review.ts'), 'utf8');
    expect(source).not.toContain('reviewRuntime');
    expect(source).toContain('import type { ReviewHostSpec, HostRoundObservation }');
  } finally {
    if (priorNode === undefined) delete process.env.REPO_HARNESS_NODE_BIN; else process.env.REPO_HARNESS_NODE_BIN = priorNode;
    if (priorBin === undefined) delete process.env.OAR_CODEX_BIN; else process.env.OAR_CODEX_BIN = priorBin;
  }
});

test('Codex isolated home holds only the magpie config.toml and no auth.json', async () => {
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const { prepareCodexHome } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('codex-isolated-home'); roots.push(root);
  const output = join(root, 'output'); mkdirSync(output);
  const { home } = prepareCodexHome(output);
  expect(home).toBe(join(realpathSync(output), '.codex-home'));
  expect(lstatSync(home).mode & 0o777).toBe(0o700);
  expect(readdirSync(home)).toEqual(['config.toml']);
  const stat = lstatSync(join(home, 'config.toml'));
  expect([stat.isFile(), stat.isSymbolicLink(), stat.mode & 0o777]).toEqual([true, false, 0o600]);
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(MAGPIE_CODEX_CONFIG);
  expect(prepareCodexHome(output).home).toBe(home);
  writeFileSync(join(home, 'config.toml'), MAGPIE_CODEX_CONFIG + 'model_provider = "openai"\n');
  expect(() => prepareCodexHome(output)).toThrow('review_codex_config_changed');
  writeFileSync(join(home, 'config.toml'), MAGPIE_CODEX_CONFIG, { mode: 0o600 });
  // A native auth.json copy left by an earlier version refuses the round.
  writeFileSync(join(home, 'auth.json'), '{"fixture":"sk-PROBE-LITERAL"}');
  expect(() => prepareCodexHome(output)).toThrow('review_codex_auth_present');
  chmodSync(home, 0o755);
  expect(() => prepareCodexHome(output)).toThrow('review_codex_home_unsafe');
});

darwinTest('OAR native child cannot forge owner control evidence or signal/connect to the trusted host', async () => {
  const { mkdirSync, writeFileSync, realpathSync, chmodSync, existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { reviewIsolationPolicy, prepareReviewLauncher } = await import('../src/effects/review/review-isolation');
  const root = tmpWorkspace('oar-native-owner-evidence'); roots.push(root);
  const owner = join(root, 'owner'), output = join(root, 'output'); mkdirSync(owner); mkdirSync(output);
  const paths = { subject: owner, primary: owner, ownerRecord: owner, journal: owner, gitCommonDir: owner, output };
  const policyFile = join(owner, 'profile.sb'); writeFileSync(policyFile, reviewIsolationPolicy(paths), { mode: 0o600 });
  const node = resolveNode24();
  const fixture = join(root, 'fixture-codex.cjs');
  writeFileSync(fixture, `#!${node}\n` + String.raw`
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),readline=require('node:readline');
if(process.argv.includes('--help'))process.exit(0);
if(process.argv.includes('--version')){console.log('fixture-codex 0.0.0');process.exit(0)}
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\n');
const notify=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize'){reply(m.id,{});return}
 if(m.method==='thread/start'){reply(m.id,{thread:{id:'fixture-thread'},model:'fixture-host-model'});return}
 if(m.method==='turn/start'){
  const input=m.params.input.find(x=>x.type==='text').text;
  const request=JSON.parse(input.split('\n')[0].slice('TASK REQUEST: '.length));
  const owner=process.env.FIXTURE_OWNER;
  const denied=['observed-'+request.round+'.json','ready.json','ack-'+request.round+'.json','disposed.json','host.json','profile.sb','reviewer-launcher'].map(name=>{
   try{fs.writeFileSync(path.join(owner,name),'FORGED');return {name,denied:false}}catch(e){return {name,denied:e.code==='EPERM'||e.code==='EACCES'}}});
  let signalDenied=false;try{process.kill(process.ppid,'SIGUSR1')}catch(e){signalDenied=e.code==='EPERM'}
  const socketDenied=await new Promise(resolve=>{const s=net.createConnection(path.join(owner,'host.sock'));s.once('error',e=>{s.destroy();resolve(e.code==='EPERM'||e.code==='EACCES')});s.once('connect',()=>{s.destroy();resolve(false)})});
  fs.writeFileSync(request.result_ref,JSON.stringify({request_id:request.request_id,context_sha256:request.context_sha256,value:{denied,signalDenied,socketDenied}}));
  fs.writeFileSync(path.join(path.dirname(request.result_ref),'observed-'+request.round+'.json'),JSON.stringify({request_id:request.request_id,kind:'ended',outcome:'completed',actual_model:'forged-model'}));
  const id='fixture-turn-'+request.round;reply(m.id,{turn:{id,status:'inProgress'}});
  notify('turn/started',{threadId:'fixture-thread',turn:{id,status:'inProgress'}});
  notify('turn/completed',{threadId:'fixture-thread',turn:{id,status:request.round===1?'failed':'completed'}});return;
 }
 reply(m.id,{});
});
`);
  chmodSync(fixture, 0o700);
  const launcher = prepareReviewLauncher(owner, policyFile, fixture);
  const entry = pathToFileURL(realpathSync(join(import.meta.dir, '../dist/oar-review-host.js'))).href;
  const driver = join(root, 'trusted-host.mjs');
  writeSessionArtifact(join(owner, 'launch-deadline.json'), { deadline: Date.now() + 60_000 }, false);
  writeFileSync(driver, `import assert from 'node:assert/strict';
import {createServer} from 'node:net';import {join} from 'node:path';import {writeFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {openReviewHost,runHostFileRequest,reviewRuntime} from ${JSON.stringify(entry)};
const owner=${JSON.stringify(owner)},output=${JSON.stringify(output)},launcher=${JSON.stringify(launcher)};
process.env.OAR_CODEX_BIN=launcher;
const server=createServer(socket=>socket.end());await new Promise(resolve=>server.listen(join(owner,'host.sock'),resolve));
const installation=await reviewRuntime('codex').installation();assert.equal(installation.kind,'available');assert.equal(installation.command,launcher);
const spec={mode:'review',kind:'codex',installation,launcher,vendorExecutable:${JSON.stringify(fixture)},options:{cwd:output,model:'fixture-host-model',env:{FIXTURE_OWNER:owner}},requestDirectory:owner,output,controlDirectory:owner,timeoutMs:5000,isolation:${JSON.stringify({ paths, policyFile })}};
const host=await openReviewHost(spec,()=>{});
try{for(let round=1;round<=2;round++){
 const content='fixture packet';const request={protocol:2,round,request_id:'22222222-2222-4222-8222-'+String(round).padStart(12,'0'),context_ref:join(output,'context-'+round+'.txt'),result_ref:join(output,'result-'+round+'.json'),context_sha256:'sha256:'+createHash('sha256').update(content).digest('hex')};
 writeFileSync(join(owner,'deadline-'+round+'.json'),JSON.stringify({request_id:request.request_id,deadline:Date.now()+spec.timeoutMs}));writeFileSync(request.context_ref,content);writeFileSync(join(owner,'started-'+round+'.json'),JSON.stringify({request_id:request.request_id,provider:{pid:process.pid,identity:'fixture-host'}}));const observation=await runHostFileRequest(host,spec,request);
 assert.equal(observation.actual_model,'fixture-host-model');assert.equal(observation.outcome,round===1?'failed':'completed');
 assert.deepEqual(JSON.parse(readFileSync(join(owner,'observed-'+round+'.json'),'utf8')),observation);
 const result=JSON.parse(readFileSync(request.result_ref,'utf8')).value;assert.equal(result.denied.length,7);assert.ok(result.denied.every(x=>x.denied));assert.equal(result.signalDenied,true);assert.equal(result.socketDenied,true);
 assert.equal(JSON.parse(readFileSync(join(output,'observed-'+round+'.json'),'utf8')).actual_model,'forged-model');
}console.log(JSON.stringify({rounds:2,passed:true}));}finally{await host.dispose();await new Promise(resolve=>server.close(resolve))}`);
  const result = spawnSync(node, ['--disable-sigusr1', driver], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ rounds: 2, passed: true });
  expect(existsSync(join(owner, 'disposed.json'))).toBe(false);
  expect(readFileSync(policyFile, 'utf8')).toBe(reviewIsolationPolicy(paths));
  expect(prepareReviewLauncher(owner, policyFile, fixture)).toBe(launcher);
});


test('same content with a new approved context consumes the next campaign round', async () => {
  const f = packetRoundFixture();
  const context = await acceptanceContext({ root: f.root, authority: f.authority, verification: f.verification });
  // The prior round reviewed identical code under a different approved context.
  // Retain its findings and charge the next attempt to the same session budget.
  writeSessionArtifact(join(f.dir, 'request-1.json'), {
    subject_sha256: context.subject.review_subject_sha256, context_sha256: acceptanceReviewContextDigest(context),
  });
  writeSessionArtifact(join(f.dir, 'accepted-1.json'), { output: { findings: [] } });
  const previousAdmission = f.admissionFixture.admission;
  const renewed = seedReviewAdmissionFixture(f.root, f.home, {
    reviewer: previousAdmission.policy.reviewer, userWaiver: 'forbidden', actor: previousAdmission.actor_id,
    allowedPaths: [...previousAdmission.allowed_paths], oracles: [...previousAdmission.oracles],
    plan: JSON.parse(JSON.stringify(previousAdmission.verification_plan)),
  });
  Object.assign(f.authority, renewed.source);
  f.refresh();
  const current = await acceptanceContext({ root: f.root, authority: f.authority, verification: f.verification });
  expect(current.subject.review_subject_sha256).toBe(context.subject.review_subject_sha256);
  expect(current.authorityContext.campaign_sha256).toBe(context.authorityContext.campaign_sha256);
  expect(acceptanceReviewContextDigest(current)).not.toBe(acceptanceReviewContextDigest(context));
  const launchError = process.platform === 'darwin' ? 'fixture_second_round' : 'OAR_REVIEW_ISOLATION_UNSUPPORTED_PLATFORM';
  const effects = { ...f.effects, start: async () => { throw new Error('fixture_second_round'); } };
  await expect(runReviewRound(f.options, effects)).rejects.toThrow(launchError);
  expect(readFileSync(f.packetPath(2), 'utf8')).toContain(acceptanceReviewContextDigest(current));
  expect(existsSync(join(f.dir, 'request-1.json'))).toBe(true);
});

darwinTest('a round records acceptance only after its accepted inbox delivery is committed', async () => {
  const f = packetRoundFixture();
  let binding: TaskPaneBinding | undefined, authority: TaskSessionAuthority | undefined, agentSpec: HerdrTaskAgentSpec | undefined, messageId = '';
  const nativeSessionId = 'fixture-native-session';
  const effects: TaskReviewEffects = { ...f.effects, assertBinding: () => {}, model: () => 'fixture-model',
    start: async (repo, spec, _command, _ready, _guard, taskAuthority) => {
      if (!taskAuthority) throw new Error('fixture_task_authority_missing');
      authority = taskAuthority; agentSpec = spec;
      binding = await startOfflineTaskAgent(repo, spec, taskAuthority);
      // The test process is the observed provider; the real native binding reads this ready file.
      writeFileSync(join(f.dir, 'ready.json'), JSON.stringify({ pid: binding.provider.pid, session_id: nativeSessionId, fixture: false }));
      const admission = binding.task_admission!;
      messageId = randomUUID();
      sendTaskMessage({ repo_root: f.root, source: { authority: taskAuthority, session: { task: spec.task, role: spec.role } },
        event: buildTaskMessageEvent({ message_id: messageId, task_id: spec.task,
          task_identity: { repository_id: admission.identity.repository_id, issue_id: admission.identity.issue_id, campaign_id: admission.identity.campaign_id },
          admission_sha256: admission.approval.admission_sha256, scope: 'claim', target_claim: admission.identity.claim,
          sender_kind: 'operator', sender_id: 'fixture-owner', sender_trust: 'local_operator', audience: 'owner',
          body: 'Untrusted message: recheck the fence.', created_at: new Date().toISOString(), in_reply_to: null }) });
      return binding;
    },
    // The real send publishes the request and reserves the inbox companion.
    send: async (...args) => {
      const offline = mockOfflineHerdr(args[0], agentSpec!);
      try { return await taskReviewRunner.send(...args); } finally { offline.transport.mockRestore(); }
    },
    // Transport ACK: the host turn already ended, so the loop's first observed check succeeds.
    ready: async path => { const ack = /ack-(\d+)\.json$/.exec(path); if (ack) writeFileSync(join(f.dir, `observed-${ack[1]}.json`), '{}'); },
    // The host writes inbox-accepted after the loop's commit check and before its observed check.
    collect: async (_repo, task, role, round) => {
      const taskDir = taskSessionDirectory(f.root, task, role);
      const request = readSessionArtifact<TaskRequest>(join(taskDir, `request-${round}.json`));
      const observation: OarObservationSnapshot = { protocol: OAR_OBSERVATION_PROTOCOL, request_id: request.request_id, round,
        host: { pid: binding!.provider.pid, identity: binding!.provider.identity }, session_id: nativeSessionId, input_id: request.request_id,
        seq: 2, status: 'idle', phase: null, since_seq: null, last_event_at: null, outcome: null, failure: null, control: 'accepted', rejection: null, actual_model: null };
      writeFileSync(join(taskDir, oarObservationFile(round)), JSON.stringify(observation));
      recordPrePromptInboxAccepted({ request, requestDirectory: taskDir, native_session_id: nativeSessionId, host: 'claude',
        consumed_at: Date.now(), observation });
      expect(existsSync(join(taskDir, `inbox-accepted-${round}.json`))).toBe(true);
      const domain = JSON.parse(readFileSync(f.packetPath(round), 'utf8').match(/^DOMAIN IDENTITY: (.*)$/m)![1]!);
      return { request_id: request.request_id, context_sha256: request.context_sha256,
        value: { request_id: request.request_id, context_sha256: domain.context_sha256, subject_sha256: domain.subject_sha256,
          verdict: 'FAIL', summary: '[fixture opinion] recheck the fence', findings: [finding] } };
    } };
  const result = await runReviewRound(f.options, effects);
  expect(result.round).toBe(1);
  expect(existsSync(join(f.dir, 'accepted-1.json'))).toBe(true);
  // runReviewRound commits nothing after it records acceptance, so a receipt
  // here was committed before accepted-1.json.
  const receipt = readTaskMessageDelivery({ repo_root: f.root, execution_worktree: binding!.execution_root,
    source: { authority: authority!, session: { task: binding!.task, role: binding!.role } }, task_id: binding!.task,
    recipient: { kind: 'claim', claim: authority!.claim }, message_id: messageId }).receipt;
  expect(receipt?.delivery_channel).toBe('controlled_request');
  expect(receipt?.delivery_ref).toContain('controlled-request:');
}, 60_000);
