// Standalone-safe acceptance fixtures. Keep test-runner lifecycle hooks in repo-fixture.ts.
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ReviewEffects } from '../../src/effects/review/generic-review';
import type { HerdrCoreEndpoint, TaskPaneBinding } from '../../src/effects/terminal/task-session-record';
type TaskReviewEffects = ReviewEffects<TaskPaneBinding, HerdrCoreEndpoint>;

/** Explicit synthetic fixture opinion; never converts a real provider claim into PASS. */
export async function fixtureReviewResult(args: {
  root: string; authority: import('../../src/effects/admission/admission-source').ReviewAdmissionSource; verification: string; reviewer: string;
  disposition: string; summary: string; findings: import('../../scripts/acceptance-receipt').AcceptanceFinding[];
}): Promise<import('../../scripts/acceptance-receipt').AcceptanceReviewResult> {
  const { acceptanceContext, acceptanceReviewContextDigest } = await import('../../scripts/acceptance-receipt');
  const context = await acceptanceContext(args);
  return { request_id: 'fixture-review-request', context_sha256: acceptanceReviewContextDigest(context),
    subject_sha256: context.subject.review_subject_sha256, actual_harness: args.reviewer === 'Codex' ? 'codex' : 'claude',
    actual_role: 'deep-reasoner', actual_model: 'fixture-model', verdict: args.disposition === 'external_pass' ? 'PASS' : 'FAIL',
    summary: args.summary, findings: args.findings };
}

/** A fixture opinion has no bound author task session. */
export async function recordFixtureAcceptance(args: Omit<Parameters<typeof import('../../scripts/acceptance-receipt').recordAcceptance>[0], 'author'>) {
  const { recordAcceptance } = await import('../../scripts/acceptance-receipt');
  if (args.disposition === 'user_waiver') return recordAcceptance({ ...args, author: null });
  return recordAcceptance({ ...args, author: null, reviewResult: args.reviewResult ?? await fixtureReviewResult(args) });
}

export const finding = { id: 'f', severity: 'P1' as const, status: 'new' as const, message: '[fixture opinion] fix the fence' };

export function expectNoStoredPiProbe(directory: string): void {
  const { expect } = require('bun:test') as typeof import('bun:test');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) expectNoStoredPiProbe(path);
    else if (entry.isFile()) expect(readFileSync(path, 'utf8'), path).not.toContain('sk-PROBE-LITERAL');
  }
}

export function resolveNode24(): string {
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

/** A resolver double for fixtures that do not test model resolution: the settings reference is canonical. */
export const piReferenceResolver = (_agentDirectory: string, reference: string) =>
  ({ provider: reference.slice(0, reference.indexOf('/')), model: reference.slice(reference.indexOf('/') + 1) });
export const inOneHour = () => Date.now() + 3_600_000;
/** The generated review configuration (#2764): magpie constants only. */
const MAGPIE_PI_MODELS = { providers: { magpie: { baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-completions', apiKey: 'magpie',
  models: [{ id: 'codex/gpt-6.2-astra', reasoning: true }] } } };
const MAGPIE_PI_SETTINGS = { defaultProvider: 'magpie', defaultModel: 'codex/gpt-6.2-astra', defaultThinkingLevel: 'high' };
export const MAGPIE_CODEX_CONFIG = 'model = "codex/gpt-6.2-astra"\nmodel_provider = "magpie"\n\n[model_providers.magpie]\nname = "magpie"\n'
  + 'base_url = "http://127.0.0.1:3425/v1"\nwire_api = "responses"\nexperimental_bearer_token = "magpie"\n'
  + 'http_headers = { "x-openai-actor-authorization" = "magpie" }\n';
/** Each generated file is a 0600 regular file, never a link; pi's auth.json is the empty map. */
export function expectGeneratedPiDirectory(directory: string): void {
  const { expect } = require('bun:test') as typeof import('bun:test');
  expect(readdirSync(directory).sort()).toEqual(['auth.json', 'models.json', 'settings.json']);
  for (const name of ['auth.json', 'models.json', 'settings.json']) {
    const stat = lstatSync(join(directory, name));
    expect([stat.isFile(), stat.isSymbolicLink(), stat.mode & 0o777], name).toEqual([true, false, 0o600]);
  }
  expect(readFileSync(join(directory, 'auth.json'), 'utf8')).toBe('{}');
  expect(JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8'))).toEqual(MAGPIE_PI_MODELS);
  expect(JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))).toEqual(MAGPIE_PI_SETTINGS);
}

/** Each test file owns its fixture cache and cleanup hooks. */
export function createPacketRoundFixtures(roots: string[]) {
  const { expect } = require('bun:test') as typeof import('bun:test');
  const { fixtureTemplate, tmpWorkspaceIn } = require('./repo-fixture') as typeof import('./repo-fixture');
  const { seedAcceptanceFixture } = require('./verification-plan-fixture') as typeof import('./verification-plan-fixture');
  const { reviewLocation } = require('../../src/effects/review/generic-review') as typeof import('../../src/effects/review/generic-review');
  const { taskReviewRunner } = require('../../src/effects/review-runner/task-review-runner') as typeof import('../../src/effects/review-runner/task-review-runner');
  const { executeAdmittedVerification } = require('../../src/effects/evidence/verification-execution') as typeof import('../../src/effects/evidence/verification-execution');
  const { prepareChangeAssessment } = require('../../src/effects/review/change-assessment') as typeof import('../../src/effects/review/change-assessment');
  const { canonicalize } = require('../../src/core/evidence/canonical-json') as typeof import('../../src/core/evidence/canonical-json');
  type JsonValue = import('../../src/core/evidence/types').JsonValue;
  const packetRepositoryTemplate = fixtureTemplate(() => {
    const fixture = seedAcceptanceFixture('review-packet');
    execFileSync('git', ['-C', fixture.root, 'worktree', 'add', '-qb', 'packet-reviewer', join(fixture.home, 'reviewer')]);
    return fixture;
  }, fixture => [fixture.root, fixture.home]);

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

  return { packetRoundFixture, dispose: () => packetRepositoryTemplate.dispose() };
}
