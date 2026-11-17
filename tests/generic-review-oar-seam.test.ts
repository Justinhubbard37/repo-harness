import { seedReviewAdmissionFixture } from './helpers/review-admission-fixture';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { darwinTest } from './helpers/darwin-test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { runReviewRound, type ReviewEffects } from '../src/effects/review/generic-review';
import { taskReviewRunner } from '../src/effects/review-runner/task-review-runner';
import { taskSessionDirectory, type HerdrCoreEndpoint, type HerdrTaskAgentSpec, type TaskPaneBinding } from '../src/effects/terminal/task-session-record';
import { readSessionArtifact, writeSessionArtifact } from '../src/effects/terminal/task-session-io';
import type { ReviewHostSpec, TaskRequest } from '../src/core/review/runner-port';
import type { TaskSessionAuthority } from '../src/effects/admission/admission-source';
import { tmpWorkspace } from './helpers/repo-fixture';
import { randomUUID } from 'crypto';
import { mockOfflineHerdr, offlineTerminalAddress, startOfflineTaskAgent } from './helpers/engineer-runtime-fixture';
import { buildTaskMessageEvent } from '../src/core/fleet/admitted-task-message';
import { readTaskMessageDelivery, sendTaskMessage } from '../src/effects/fleet/task-inbox';
import { recordPrePromptInboxAccepted } from '../src/effects/review-runner/task-pre-prompt-inbox-consumer';
import { OAR_OBSERVATION_PROTOCOL, oarObservationFile, type OarObservationSnapshot } from '../src/effects/terminal/task-runtime-observation';
import { createPacketRoundFixtures, expectNoStoredPiProbe, expectGeneratedPiDirectory, resolveNode24, MAGPIE_CODEX_CONFIG, finding } from './helpers/acceptance-fixture';
type TaskReviewEffects = ReviewEffects<TaskPaneBinding, HerdrCoreEndpoint>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const { packetRoundFixture, dispose } = createPacketRoundFixtures(roots);
afterAll(dispose);

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
  // Order, not a wall-clock margin. The preflight wrote its last timestamp at or before the return, so
  // no work continues after the host returned; load moves both times together.
  expect(run.lastWorkAfter).toBeLessThanOrEqual(run.returnedAfter);
  // The return never precedes the deadline. A stuck disposal cannot settle early, so the stop waits out
  // the host's DEADLINE_STOP_MS grace; load can only lengthen that wait.
  expect(run.returnedAfter).toBeGreaterThanOrEqual(stage === 'stuck disposal' ? 5000 : 0);
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
