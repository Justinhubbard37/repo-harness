import { createPacketRoundFixtures, expectGeneratedPiDirectory, resolveNode24, piReferenceResolver, inOneHour, MAGPIE_CODEX_CONFIG, finding } from './helpers/acceptance-fixture';
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
import { closeReview, reviewStatus, runReviewRound, type ReviewEffects } from '../src/effects/review/generic-review';
import { reviewSessionOptions, taskReviewRunner } from '../src/effects/review-runner/task-review-runner';
import { resolvePiModel } from '../src/effects/pi-host-probe';
import { acceptanceContext, acceptanceReviewContextDigest, acceptanceReceiptPath } from '../scripts/acceptance-receipt';
import { seedAcceptanceFixture } from './helpers/verification-plan-fixture';
import { canonicalize } from '../src/core/evidence/canonical-json';
import type { JsonValue } from '../src/core/evidence/types';
import { prepareChangeAssessment } from '../src/effects/review/change-assessment';
import { executeAdmittedVerification, evaluateAdmittedVerification } from '../src/effects/evidence/verification-execution';
import { type HerdrCoreEndpoint, type TaskPaneBinding } from '../src/effects/terminal/task-session-record';
import { observeTaskSessionAdmission } from '../src/effects/terminal/task-session-admission';
import { readSessionArtifact, writeSessionArtifact } from '../src/effects/terminal/task-session-io';
import { ensureSessionDirectory, nextSessionRound } from '../src/effects/terminal/task-session-io';
import type { ReviewHostSpec, TaskRequest } from '../src/core/review/runner-port';
import { tmpWorkspace, tmpWorkspaceIn } from './helpers/repo-fixture';
import { randomUUID } from 'crypto';
import { startOfflineTaskAgent } from './helpers/engineer-runtime-fixture';
type TaskReviewEffects = ReviewEffects<TaskPaneBinding, HerdrCoreEndpoint>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
const fail = { ...identity, verdict: 'FAIL', summary: '[fixture opinion] revise', findings: [finding] };
const packetInput: ReviewPacketInput = Object.freeze({ context_sha256: 'domain-context', subject_sha256: 'subject',
  actual_harness: 'claude', actual_role: 'deep-reasoner', prior_findings: Object.freeze([Object.freeze(finding)]),
  admission: 'admission\n', goal: 'goal\n', verification: 'verification\n', source: 'source\n' });
test('review packet preserves the exact transport text, domain identity and prior findings', () => {
  // Frozen pre-extraction bytes. Do not derive this expectation from the builder or shared rule.
  const expected = [
    'Review the complete current subject against its goal, approved admission and prepared verification evidence. Do not edit production code or invoke other reviewers. Only author one final JSON file to the exact request.result_ref; no temp/rename or alternate submission. Terminal output and idle are observation only.',
    'Outer transport JSON is {request_id: request.request_id, context_sha256: request.context_sha256, value: domain output}. Provider value has EXACTLY request_id, context_sha256, subject_sha256, verdict, summary, findings. Domain request_id is request.request_id; domain context_sha256 is the prepared domain hash below (distinct from transport packet hash). The owner adds actual harness/role/model from the bound task-agent and OAR Session observation, not your self-description.',
    'PASS requires no unresolved P0 or P1; an unresolved P2 or P3 does not block. FAIL requires at least one unresolved P0 or P1 finding. A finding that touches I1 (a credential leak) or I2 (an unauthorized deletion or overwrite of a user file) is rated at least P1. Each finding has EXACTLY id, severity:P0|P1|P2|P3, status:new|open|resolved, message. Keep stable IDs: every prior finding must remain resolved/open with current evidence. A previous verdict is not evidence for current code.',
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

const { packetRoundFixture, dispose } = createPacketRoundFixtures(roots);
afterAll(dispose);

/** The repo's own pi 1.5.2 package; its resolver runs offline with an empty credential store. */
const PI_PACKAGE_CLI = join(import.meta.dir, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
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
  // Intel CI took 43.62 s and exceeded 60 s; allow 120 s for this multi-round lifecycle case (#2976).
}, 120_000);

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
  // A P2 or a P3 is a follow-up, so the same PASS verdict accepts it (#2936).
  for (const severity of ['P2', 'P3'] as const) {
    const followUp = { ...finding, id: 'f2', severity };
    expect(validateReviewOutput({ ...fail, verdict: 'PASS', findings: [followUp] }, identity).findings).toEqual([followUp]);
    expect(() => validateReviewOutput({ ...fail, findings: [{ ...followUp, status: 'open' }] }, identity)).toThrow('review_conflicting_verdict');
  }
  expect(() => validateReviewOutput({ ...fail, findings: [finding, finding] }, identity)).toThrow('review_malformed_finding');
  expect(() => validateReviewOutput(fail, identity, [finding])).toThrow('review_previous_finding_unaddressed');
  expect(() => validateReviewOutput({ ...fail, findings: [] }, identity, [finding])).toThrow('review_previous_finding_unaddressed');
  const resolved = { ...finding, status: 'resolved' as const };
  expect(validateReviewOutput({ ...fail, verdict: 'PASS', findings: [resolved] }, identity, [finding]).findings).toEqual([resolved]);
  for (const findings of [[], [resolved], [{ ...resolved, severity: 'P0' }]]) {
    expect(() => validateReviewOutput({ ...fail, findings }, identity)).toThrow('review_conflicting_verdict');
  }
  for (const severity of ['P0', 'P1']) for (const status of ['new', 'open']) {
    expect(validateReviewOutput({ ...fail, findings: [{ ...finding, severity, status }] }, identity).verdict).toBe('FAIL');
  }
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
  // Three native Pi sessions hit 30 s on Intel CI; allow 60 s for the child and 90 s for this case (#2976).
  const result = spawnSync(node, [worker], { encoding: 'utf8', timeout: 60_000,
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
}, 90_000);

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
