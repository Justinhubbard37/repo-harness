import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestJson, type Json } from 'archctx-contracts';
import {
  ARCH_VERIFY_CHECK_IDS,
  ARCH_VERIFY_CONTRACT_CODE,
  ARCH_VERIFY_KIND,
  ARCH_VERIFY_PROTOCOL,
  archVerifyCheck,
  archVerifyExitCode,
  archVerifyVerdict,
  buildArchVerifyReport,
  formatArchVerifyText,
  type ArchVerifyCheckId,
  type ArchVerifyCheckRead,
  type ArchVerifyCheckV1,
} from '../../src/core/architecture/arch-verify';
import { ARCH_VERIFY_BASE_INVALID, archVerify, runArchVerifyCommand } from '../../src/cli/commands/arch-verify';
import { indexPackageLocalCodeGraph, resolveCompatibleNodeRuntime } from '../../src/effects/architecture/archctx-provider';
import { ARCHCTX_REQUIRED_VERSION } from '../../src/core/architecture/projection';
import type { ArchitectureProjectionPolicy, RunArchctxProcess } from '../../src/core/architecture/contracts';
import { fixtureCommit, fixtureWrite, fixtureYaml, moduleRepository } from '../helpers/module-repository';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The policy the global configuration holds on an installed machine; the test HOME has none. */
const policy: ArchitectureProjectionPolicy = { provider: 'archctx', applyMode: 'manual', requiredVersion: ARCHCTX_REQUIRED_VERSION, timeoutMs: 120_000 };

/**
 * A fixture repository whose model validates: the module model, plus the product
 * intent file. `proven` makes the source call its declared sink; without the call
 * the flow proof fails.
 */
function validRepository(proven = true): string {
  const root = realpathSync(moduleRepository());
  roots.push(root);
  fixtureWrite(root, '.archcontext/product.yaml', fixtureYaml({
    schemaVersion: 'archcontext.product/v1', id: 'product.test', name: 'test', purpose: 'Test the verdict.',
    capabilities: ['test'], nonGoals: [], riskDomains: [], successCriteria: ['The verdict is measured.'],
    users: [{ description: 'Developer.', id: 'developer' }],
  }));
  fixtureWrite(root, 'src/module/read.ts', proven ? "import { project } from './core';\nexport const read = () => project();\n" : 'export const read = () => 1;\n');
  // The index is local state that no commit carries.
  writeFileSync(join(root, '.gitignore'), '.codegraph/\n');
  fixtureCommit(root);
  return root;
}

const check = (id: ArchVerifyCheckId, status: ArchVerifyCheckV1['status'], count = 0): ArchVerifyCheckV1 => ({ id, status, count });
const data = (value: unknown): ArchVerifyCheckRead => ({ ok: true, data: value });
const failed = (code: string) => ({ ok: false, error: { code, message: `${code} happened` } }) as const;

/** Re-binds a derived debt report so only the property under test disagrees. */
function redigest(report: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...body } = report;
  return { ...body, digest: digestJson(body as unknown as Json) };
}

/** One valid report; `digest` binds it unless the test needs a broken binding. */
function debtReport(items: number): Record<string, unknown> {
  const body = {
    schemaVersion: 'archcontext.architecture-debt/v1',
    scope: { kind: 'repository', changedPaths: [], capabilityIds: [] },
    coverage: items === 0 ? 'complete' : 'partial', coverageReasonCodes: items === 0 ? [] : ['anchors:path-ambiguous'],
    checks: [
      { check: 'ownership', coverage: 'complete', reasonCodes: [] },
      { check: 'anchors', coverage: items === 0 ? 'complete' : 'partial', reasonCodes: items === 0 ? [] : ['path-ambiguous'] },
      { check: 'dependencies', coverage: 'complete', reasonCodes: [] }, { check: 'flows', coverage: 'complete', reasonCodes: [] },
      { check: 'state-machines', coverage: 'complete', reasonCodes: [] }, { check: 'practices', coverage: 'complete', reasonCodes: [] },
    ],
    items: Array.from({ length: items }, (_, index) => ({
      id: `debt.${'a'.repeat(63)}${index}`, kind: 'stale-anchor', nodeIds: [], capabilityIds: [], paths: [],
      reasonCode: 'line-moved', action: 'archctx docs anchors --json', details: {},
    })),
    actionsRequired: items === 0 ? [] : ['archctx docs anchors --json'],
  };
  return redigest(body);
}

/** A `line-out-of-range` finding, the one kind that needs no CodeGraph symbol read. */
const anchorFinding = (index: number) => ({
  kind: 'line-out-of-range' as const,
  origin: { kind: 'document' as const, path: `docs/modules/${index}.md`, line: 3 },
  citation: { text: `src/${index}.ts:99`, path: `src/${index}.ts`, line: 99 },
  lineCount: 4,
});

/** One valid report: each finding and unchecked citation sits on its own node, as the contract requires. */
const anchorsReport = (findings: number, unchecked = 0, availability: 'ready' | 'unavailable' = 'ready') => {
  const noFacts = availability === 'unavailable';
  const nodes = [
    ...Array.from({ length: findings }, (_, index) => ({
      nodeId: `capability.test.f${index}`, citationCount: 1, findings: [anchorFinding(index)], unchecked: [],
    })),
    ...Array.from({ length: unchecked }, (_, index) => ({
      nodeId: `capability.test.u${index}`, citationCount: 1, findings: [],
      unchecked: [{
        reasonCode: noFacts ? ('codegraph-unavailable' as const) : ('language-unsupported' as const),
        origin: { kind: 'document' as const, path: `docs/modules/u${index}.md`, line: 3 },
        citation: { text: `src/u${index}.ts`, path: `src/u${index}.ts` },
      }],
    })),
  ].sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
  return {
    schemaVersion: 'archcontext.docs-anchors/v1', profile: 'default',
    codeGraph: noFacts ? { availability, reasonCode: 'index-missing' as const } : { availability },
    summary: {
      nodes: nodes.length, documents: nodes.length, citations: findings + unchecked, findings, unchecked,
      byKind: { 'line-moved': 0, 'line-out-of-range': findings, 'missing-path': 0, 'missing-symbol': 0, 'unknown-selector': 0 },
    },
    nodes,
  };
};

/** A capability whose P2 flow proof failed, with the diagnostics archctx reports for it. */
const unprovable = (diagnostics: string[]) => ({
  capabilityId: 'capability.test.module', p2Status: 'unprovable' as const,
  diagnostics: diagnostics.map((code) => ({ code, detail: 'entrypoint.test.read -> sink.test.core' })),
});

/**
 * A `flows check` report. `capabilities` is the second authority: archctx sets
 * `ok: false` for a failing flow proof even when every declared selector is proven.
 */
const flowsReport = (proven: number, unproven: number, capabilities: unknown[] = [], ok = unproven === 0) => ({
  schemaVersion: 'archcontext.flow-selector-check/v1', ok,
  codeGraph: { availability: 'ready', version: '1.6.2' },
  summary: { selectors: proven + unproven, proven, unproven, usedUnproven: 0 },
  selectors: [
    ...Array.from({ length: proven }, (_, index) => ({
      nodeId: `capability.test.${index}`, entrypointId: 'entrypoint.test.read', sourcePath: 'src/a.ts', sourceSymbol: 'read',
      sinkId: 'sink.test.core', sinkPath: 'src/b.ts', sinkSymbol: 'project', status: 'proven' as const,
      callSites: [{ path: 'src/a.ts' }], referenceSites: [], rejectedBuiltinCallSites: [], flowSteps: [],
    })),
    ...Array.from({ length: unproven }, (_, index) => ({
      nodeId: `capability.test.u${index}`, entrypointId: 'entrypoint.test.read', sourcePath: 'src/a.ts', sourceSymbol: 'read',
      sinkId: 'sink.test.core', sinkPath: 'src/b.ts', sinkSymbol: 'project', status: 'no-direct-call' as const,
      callSites: [], referenceSites: [], rejectedBuiltinCallSites: [], flowSteps: [],
    })),
  ],
  capabilities,
});

const constraintReport = (status: string, coverage: string, violations = 0, unresolved = 0) => ({
  schemaVersion: 'archcontext.dependency-constraint-evaluation/v1', status, coverage,
  reasonCodes: coverage === 'complete' ? [] : ['code-facts-unavailable'], constraintIds: ['constraint.test.layers'], importEdgeCount: 0,
  unresolvedImports: Array.from({ length: unresolved }, (_, index) => ({ from: `src/${index}.ts`, specifier: './gone' })),
  violations: Array.from({ length: violations }, (_, index) => ({
    constraintId: 'constraint.test.layers', fromPath: `src/${index}.ts`, toPath: 'src/core.ts',
    fromNode: 'component.test.a', toNode: 'component.test.b', severity: 'error' as const,
  })),
  warnings: [],
});

const projectionReport = (renderEquivalent: boolean | null, differing = 0, humanEdited = 0, verdict = 'no-changes') => {
  const generatedOnly = verdict === 'generated-only-not-render-equivalent' || verdict === 'generated-only-render-equivalent';
  const edited = Array.from({ length: humanEdited }, (_, index) => `docs/${index}.md`);
  return {
    schemaVersion: 'archcontext.projection-pr-verification/v1', base: 'main',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBase: 'a'.repeat(40),
    // The contract permits a human-edited target only in a diff that touches a non-generated path.
    changedPaths: [], nonGeneratedPaths: verdict === 'touches-non-generated' ? ['src/a.ts', ...edited] : [],
    humanEditedPaths: verdict === 'touches-non-generated' ? edited : [],
    generatedOnly, renderEquivalent, differingPaths: Array.from({ length: differing }, (_, index) => `docs/${index}.md`),
    projectionStatus: null, verdict,
  };
};

const machineReport = (rules: string[], breaks = 0, anchors: string[] = []) => ({
  schemaVersion: 'archcontext.state-machine-check/v1',
  machines: [{
    id: 'state-machine.test.read', capabilityId: 'capability.test.module', reachableStates: 1, transitions: 0,
    rules: rules.map((status, index) => (status === 'finding-open' || status === 'finding-resolved'
      ? { id: `rule-${index}`, kind: 'never', status, tracking: `https://github.com/a/b/issues/${index}`, ...(status === 'finding-open' ? { state: { region: 'r' }, path: [] } : {}) }
      : status === 'broken'
        ? { id: `rule-${index}`, kind: 'never', status, state: { region: 'r' }, path: [] }
        : { id: `rule-${index}`, kind: 'never', status })),
    breaks: Array.from({ length: breaks }, (_, index) => ({ kind: 'unreachable-state' as const, region: 'r', state: `s${index}` })),
    anchors: anchors.map((status, index) => ({
      owner: 'event' as const, ownerId: `event-${index}`, path: `src/${index}.ts`, status,
      ...(status === 'anchor-unconfirmed' || status === 'anchor-changed' || status === 'confirmed' ? { digest: `sha256:${'a'.repeat(64)}` } : {}),
      ...(status === 'unchecked' ? { symbol: 'read', reason: 'index-missing' as const } : {}),
    })),
  }],
});

describe('rh arch verify: one status per check', () => {
  test('validate reports one finding per model error, and an invalid model always counts', () => {
    expect(archVerifyCheck('validate', data({ valid: true, errors: [] }))).toEqual({ id: 'validate', status: 'pass', count: 0 });
    expect(archVerifyCheck('validate', data({ valid: false, errors: ['a', 'b'] }))).toEqual({ id: 'validate', status: 'findings', count: 2 });
    expect(archVerifyCheck('validate', data({ valid: false, errors: [] })).count).toBe(1);
    expect(archVerifyCheck('validate', data({ valid: 'yes' }))).toMatchObject({ status: 'error', error: { code: ARCH_VERIFY_CONTRACT_CODE } });
  });

  test('flows reports one finding per unproven selector, and an unavailable index is not a pass', () => {
    expect(archVerifyCheck('flows', data(flowsReport(3, 0)))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('flows', data(flowsReport(2, 1)))).toMatchObject({ status: 'findings', count: 1 });
    expect(archVerifyCheck('flows', data({ ...flowsReport(0, 0), codeGraph: { availability: 'unavailable', version: '1.6.2' } })))
      .toMatchObject({ status: 'unavailable', count: 0, error: { code: 'AC_CODE_FACTS_UNAVAILABLE' } });
  });

  // A flow can fail on a relation, a participant or an outcome while every declared selector is proven,
  // so `ok: false` and the unprovable capability carry the only signal there is.
  test('a flow whose capability proof fails is a finding even when every selector is proven', () => {
    const report = flowsReport(1, 0, [unprovable(['relation-binding-missing'])], false);
    expect(archVerifyCheck('flows', data(report))).toEqual({ id: 'flows', status: 'findings', count: 1 });
    // Each diagnostic is one finding, and a capability with no diagnostic still counts once.
    expect(archVerifyCheck('flows', data(flowsReport(1, 0, [unprovable(['relation-binding-missing', 'outcome-missing'])], false))).count).toBe(2);
    expect(archVerifyCheck('flows', data(flowsReport(1, 0, [{ capabilityId: 'capability.test.module', p2Status: 'unprovable', diagnostics: [] }], false))).count).toBe(1);
    // A proven capability and a passing gate stay a pass.
    expect(archVerifyCheck('flows', data(flowsReport(1, 0, [{ capabilityId: 'capability.test.module', p2Status: 'proven', diagnostics: [] }]))))
      .toMatchObject({ status: 'pass', count: 0 });
  });

  test('a failing capability with no selector at all is a finding, not an empty pass', () => {
    expect(archVerifyCheck('flows', data(flowsReport(0, 0, [unprovable(['selector-declaration-missing'])], false))))
      .toEqual({ id: 'flows', status: 'findings', count: 1 });
  });

  test('selector failures and capability diagnostics add up in one count', () => {
    const report = flowsReport(1, 2, [unprovable(['duplicate-participant', 'outcome-missing'])], false);
    expect(archVerifyCheck('flows', data(report))).toEqual({ id: 'flows', status: 'findings', count: 4 });
  });

  test('a producer that marks its own subject not ok never becomes pass', () => {
    // The gate is authoritative: an unenumerated failure is one finding, never a silent pass.
    expect(archVerifyCheck('flows', data(flowsReport(0, 0, [], false)))).toEqual({ id: 'flows', status: 'findings', count: 1 });
    expect(archVerifyCheck('constraints', data(constraintReport('violated', 'complete')))).toMatchObject({ status: 'findings', count: 1 });
    expect(archVerifyCheck('validate', data({ valid: false, errors: [] }))).toMatchObject({ status: 'findings', count: 1 });
  });

  test('state machines count a broken rule, an open finding, a break and a missing anchor; a gap is unavailable', () => {
    expect(archVerifyCheck('state-machines', data(machineReport(['holds'], 0, ['confirmed'])))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('state-machines', data(machineReport(['holds', 'broken'], 1, ['anchor-missing-symbol'])))).toMatchObject({ status: 'findings', count: 3 });
    expect(archVerifyCheck('state-machines', data(machineReport(['finding-open'], 0, ['confirmed'])))).toMatchObject({ status: 'findings', count: 1 });
    // A resolved finding and a changed digest are maintenance, not a disagreement.
    expect(archVerifyCheck('state-machines', data(machineReport(['finding-resolved'], 0, ['anchor-changed', 'anchor-unconfirmed'])))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('state-machines', data(machineReport(['holds'], 0, ['unchecked'])))).toMatchObject({ status: 'unavailable', count: 0 });
  });

  test('constraints count violations and unresolved imports, and an incomplete graph is unavailable', () => {
    expect(archVerifyCheck('constraints', data(constraintReport('pass', 'complete')))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('constraints', data(constraintReport('violated', 'complete', 2, 1)))).toMatchObject({ status: 'findings', count: 3 });
    expect(archVerifyCheck('constraints', data(constraintReport('not-applicable', 'unknown')))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('constraints', data(constraintReport('undetermined', 'unknown')))).toMatchObject({ status: 'unavailable', count: 0 });
  });

  test('docs anchors count stale citations, and an unmeasured citation is unavailable', () => {
    expect(archVerifyCheck('docs', data(anchorsReport(0)))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('docs', data(anchorsReport(2)))).toMatchObject({ status: 'findings', count: 2 });
    expect(archVerifyCheck('docs', data(anchorsReport(0, 3)))).toMatchObject({ status: 'unavailable', count: 0 });
    expect(archVerifyCheck('docs', data(anchorsReport(0, 0, 'unavailable')))).toMatchObject({ status: 'unavailable', count: 0 });
  });

  test('projection counts rendered differences and hand edits; a code-only change is a pass', () => {
    expect(archVerifyCheck('projection', data(projectionReport(null)))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('projection', data(projectionReport(null, 0, 0, 'touches-non-generated')))).toMatchObject({ status: 'pass', count: 0 });
    // A hand edit of a mixed-ownership target is the generator's hand-edit signal.
    expect(archVerifyCheck('projection', data(projectionReport(null, 0, 2, 'touches-non-generated')))).toMatchObject({ status: 'findings', count: 2 });
    expect(archVerifyCheck('projection', data(projectionReport(false, 2, 0, 'generated-only-not-render-equivalent')))).toMatchObject({ status: 'findings', count: 2 });
    expect(archVerifyCheck('projection', data(projectionReport(true, 0, 0, 'generated-only-render-equivalent')))).toMatchObject({ status: 'pass', count: 0 });
    // An unrenderable generated diff that names no path is still one finding.
    expect(archVerifyCheck('projection', data(projectionReport(false, 0, 0, 'generated-only-not-render-equivalent')))).toMatchObject({ status: 'findings', count: 1 });
  });

  test('debt counts measured items, and a report that measured nothing is unavailable', () => {
    expect(archVerifyCheck('debt', data(debtReport(0)))).toMatchObject({ status: 'pass', count: 0 });
    expect(archVerifyCheck('debt', data(debtReport(2)))).toMatchObject({ status: 'findings', count: 2 });
    // The decoder refuses a report whose digest does not bind it.
    expect(archVerifyCheck('debt', data({ ...debtReport(0), digest: `sha256:${'0'.repeat(64)}` }))).toMatchObject({ status: 'error', error: { code: ARCH_VERIFY_CONTRACT_CODE } });
    const unknown = debtReport(0);
    expect(archVerifyCheck('debt', data(redigest({
      ...unknown, coverage: 'unknown',
      checks: (unknown.checks as Array<{ check: string }>).map((entry) => ({ check: entry.check, coverage: 'unknown', reasonCodes: ['not-evaluated'] })),
      coverageReasonCodes: ['anchors:not-evaluated', 'dependencies:not-evaluated', 'flows:not-evaluated', 'ownership:not-evaluated', 'practices:not-evaluated', 'state-machines:not-evaluated'],
    })))).toMatchObject({ status: 'unavailable', count: 0 });
  });

  test('an archctx code decides unavailable or error; a timeout and a failed run are errors', () => {
    for (const code of ['AC_MODEL_ADOPTION_REQUIRED', 'AC_CODE_FACTS_UNAVAILABLE', 'AC_CODE_FACTS_NOT_READY']) {
      expect(archVerifyCheck('flows', failed(code))).toEqual({ id: 'flows', status: 'unavailable', count: 0, error: { code, message: `${code} happened` } });
    }
    for (const code of ['RH_ARCHCTX_TIMEOUT', 'AC_PRECONDITION_FAILED', 'RH_ARCH_VERIFY_READ_FAILED']) {
      expect(archVerifyCheck('flows', failed(code))).toMatchObject({ status: 'error', count: 0 });
    }
  });
});

describe('rh arch verify: one verdict', () => {
  test('error outranks findings, findings outrank pass, and one unavailable never changes the verdict', () => {
    expect(archVerifyVerdict([check('validate', 'pass'), check('flows', 'pass')])).toBe('pass');
    expect(archVerifyVerdict([check('validate', 'pass'), check('flows', 'unavailable')])).toBe('pass');
    expect(archVerifyVerdict([check('validate', 'pass'), check('flows', 'findings', 1), check('debt', 'unavailable')])).toBe('findings');
    expect(archVerifyVerdict([check('validate', 'findings', 1), check('flows', 'error')])).toBe('error');
    expect(archVerifyExitCode('pass')).toBe(0);
    expect(archVerifyExitCode('findings')).toBe(1);
    expect(archVerifyExitCode('error')).toBe(2);
  });

  // Nothing measured the change, so `pass` would claim a result the run does not have.
  test('a run where every check is unavailable is error with exit code 2', () => {
    const allUnavailable = ARCH_VERIFY_CHECK_IDS.map((id) => check(id, 'unavailable'));
    expect(archVerifyVerdict(allUnavailable)).toBe('error');
    expect(archVerifyExitCode(archVerifyVerdict(allUnavailable))).toBe(2);
    // One measured check is enough for the spec's mixed result.
    expect(archVerifyVerdict([...allUnavailable.slice(1), check('validate', 'pass')])).toBe('pass');
    expect(archVerifyVerdict([...allUnavailable.slice(1), check('validate', 'findings', 2)])).toBe('findings');
    // A run with no check at all is also error, not pass.
    expect(archVerifyVerdict([])).toBe('error');
  });

  test('the document has the published shape, and the text is one line per check then the verdict', () => {
    // Every check contributes its own read, in the reverse of the report order.
    const reads = [...ARCH_VERIFY_CHECK_IDS].reverse().map((id) => ({
      id,
      read: data(id === 'debt' ? debtReport(2)
        : id === 'validate' ? { valid: true, errors: [] }
          : id === 'flows' ? flowsReport(1, 0)
            : id === 'state-machines' ? machineReport(['holds'], 0, ['confirmed'])
              : id === 'constraints' ? constraintReport('pass', 'complete')
                : id === 'docs' ? anchorsReport(0) : projectionReport(null)),
    }));
    const report = buildArchVerifyReport({ base: 'a'.repeat(40), head: 'b'.repeat(40), archctxVersion: '0.15.0', reads });
    expect(Object.keys(report)).toEqual(['kind', 'protocol', 'base', 'head', 'archctx_version', 'verdict', 'checks']);
    expect(report).toMatchObject({ kind: ARCH_VERIFY_KIND, protocol: ARCH_VERIFY_PROTOCOL, base: 'a'.repeat(40), head: 'b'.repeat(40), archctx_version: '0.15.0' });
    expect(report.checks.map((entry) => entry.id)).toEqual([...ARCH_VERIFY_CHECK_IDS]);
    expect(report.verdict).toBe('findings');
    expect(report.checks.find((entry) => entry.id === 'debt')).toEqual({ id: 'debt', status: 'findings', count: 2 });
    const lines = formatArchVerifyText(report).trimEnd().split('\n');
    expect(lines).toHaveLength(ARCH_VERIFY_CHECK_IDS.length + 1);
    expect(lines[0]).toBe('validate  pass  0');
    expect(lines.at(-1)).toBe('verdict  findings');
  });

  test('a check with no read is an error, never a pass', () => {
    const report = buildArchVerifyReport({ base: 'a'.repeat(40), head: 'b'.repeat(40), archctxVersion: '0.15.0', reads: [] });
    expect(report.checks).toHaveLength(ARCH_VERIFY_CHECK_IDS.length);
    expect(report.checks.every((entry) => entry.status === 'error' && entry.error?.code === ARCH_VERIFY_CONTRACT_CODE)).toBe(true);
    expect(report.verdict).toBe('error');
  });
});

describe('rh arch verify in a repository', () => {
  test('a valid model with no finding gives pass and exit 0', () => {
    const root = validRepository();
    const result = runArchVerifyCommand(root, { base: 'HEAD', json: true }, { policy });
    if (!result.ok) throw new Error(result.error);
    const report = JSON.parse(result.document) as { verdict: string; checks: ArchVerifyCheckV1[] };
    expect(result.exitCode).toBe(0);
    expect(report.verdict).toBe('pass');
    expect(report.checks.map((entry) => entry.id)).toEqual([...ARCH_VERIFY_CHECK_IDS]);
    // No CodeGraph index exists here, so the two code-fact checks cannot pass.
    expect(report.checks.filter((entry) => entry.status !== 'unavailable').every((entry) => entry.status === 'pass')).toBe(true);
  }, 120_000);

  test('a base ref that resolves to no commit exits 2 with arch_verify_base_invalid', () => {
    const root = validRepository();
    expect(runArchVerifyCommand(root, { base: 'no-such-ref', json: true }, { policy }))
      .toEqual({ ok: false, exitCode: 2, error: `${ARCH_VERIFY_BASE_INVALID}: no-such-ref` });
    expect(runArchVerifyCommand(root, {}, { policy })).toMatchObject({ ok: false, exitCode: 2 });
  });

  test('one failing flow proof makes flows findings, the verdict findings, and the exit code 1', () => {
    // The source declares the selector but never calls its sink, so the P2 proof fails.
    // archctx@0.15.0 answers for this fixture: 1 unproven selector and 3 capability
    // diagnostics (`selector-evidence-unmatched`), so the count is 4, not 1.
    const root = validRepository(false);
    indexPackageLocalCodeGraph(root, { policy });
    const result = runArchVerifyCommand(root, { base: 'HEAD', json: false }, { policy });
    if (!result.ok) throw new Error(result.error);
    expect(result.document).toContain('flows  findings  4');
    expect(result.document.trimEnd().split('\n').at(-1)).toBe('verdict  findings');
    expect(result.exitCode).toBe(1);
  }, 120_000);

  test('without a CodeGraph index the code-fact checks are unavailable and the other checks decide', () => {
    const root = validRepository();
    const result = runArchVerifyCommand(root, { base: 'HEAD', json: true }, { policy });
    if (!result.ok) throw new Error(result.error);
    const report = JSON.parse(result.document) as { verdict: string; checks: ArchVerifyCheckV1[] };
    const byId = new Map(report.checks.map((entry) => [entry.id, entry]));
    expect(byId.get('flows')).toMatchObject({ status: 'unavailable', error: { code: 'AC_CODE_FACTS_UNAVAILABLE' } });
    expect(byId.get('docs')).toMatchObject({ status: 'unavailable' });
    expect(byId.get('debt')).toMatchObject({ status: 'pass' });
    expect(report.verdict).toBe('pass');
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test('a timeout of one check is an error for that check, so the verdict is error with exit 2', () => {
    const root = validRepository();
    const node = resolveCompatibleNodeRuntime(process.env);
    // The flows check reports a timeout; every other command runs the real pinned archctx.
    const run: RunArchctxProcess = (binary, args, options) => {
      if (args[0] === 'flows') return { status: null, signal: null, timedOut: true, stdout: '', stderr: '' };
      const result = spawnSync(node, [binary, ...args], { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    };
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = archVerify(root, base, base, true, { run });
    if (!result.ok) throw new Error(result.error);
    const report = JSON.parse(result.document) as { verdict: string; checks: ArchVerifyCheckV1[] };
    expect(report.checks.find((entry) => entry.id === 'flows')).toMatchObject({ status: 'error', count: 0, error: { code: 'RH_ARCHCTX_TIMEOUT' } });
    expect(report.verdict).toBe('error');
    expect(result.exitCode).toBe(2);
  }, 120_000);

  test('every producer envelope failing leaves nothing measured, so the verdict is error with exit 2', () => {
    // The `unavailable` codes keep their own status; the verdict still cannot claim a pass.
    const root = validRepository();
    const run: RunArchctxProcess = () => ({
      status: 1, signal: null, stderr: '',
      stdout: JSON.stringify({ schemaVersion: 'archcontext.envelope/v1', ok: false, requestId: 'probe', error: { code: 'AC_CODE_FACTS_UNAVAILABLE', message: 'no index', severity: 'error', retryable: true, action: 'codegraph-init', details: {} } }),
    });
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = archVerify(root, base, base, true, { run });
    if (!result.ok) throw new Error(result.error);
    const report = JSON.parse(result.document) as { verdict: string; checks: ArchVerifyCheckV1[] };
    expect(report.checks.every((entry) => entry.status === 'unavailable' && entry.error?.code === 'AC_CODE_FACTS_UNAVAILABLE')).toBe(true);
    expect(report.verdict).toBe('error');
    expect(result.exitCode).toBe(2);
  }, 120_000);

  test('a check that reports a decoded observation gap is error with exit 2, with no failed envelope', () => {
    // The decoder's own unavailable answers, from a report that arrived ok: the same aggregation.
    const unmeasuredDebt = redigest({ ...debtReport(0), coverage: 'unknown', coverageReasonCodes: ['anchors:not-evaluated', 'dependencies:not-evaluated', 'flows:not-evaluated', 'ownership:not-evaluated', 'practices:not-evaluated', 'state-machines:not-evaluated'],
      checks: (debtReport(0).checks as Array<{ check: string }>).map((entry) => ({ check: entry.check, coverage: 'unknown', reasonCodes: ['not-evaluated'] })) });
    const gaps = [
      archVerifyCheck('flows', data({ ...flowsReport(0, 0), codeGraph: { availability: 'unavailable', version: '1.6.2' } })),
      archVerifyCheck('docs', data(anchorsReport(0, 0, 'unavailable'))),
      archVerifyCheck('debt', data(unmeasuredDebt)),
      archVerifyCheck('constraints', data(constraintReport('undetermined', 'unknown'))),
      archVerifyCheck('state-machines', data(machineReport(['holds'], 0, ['unchecked']))),
    ];
    expect(gaps.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(archVerifyVerdict(gaps)).toBe('error');
    expect(archVerifyExitCode(archVerifyVerdict(gaps))).toBe(2);
    // One measured pass among them returns the spec's mixed result.
    expect(archVerifyVerdict([...gaps, check('validate', 'pass')])).toBe('pass');
  });
});
