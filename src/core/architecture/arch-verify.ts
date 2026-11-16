// One verdict over the ArchContext checks of a change. Each check has one pure
// function here: it decodes that check's archctx report and counts its findings.
// The effects layer runs the reads; nothing here starts a process or writes a file.

import {
  validateJsonSchema,
  type ArchitectureDebtReportV1,
  type ArchitectureFlowSelectorCheckV1,
  type DependencyConstraintEvaluationV1,
  type DocsAnchorsReportV1,
  type Json,
  type ProjectionPrVerificationV1,
  type StateMachineAnchorStatus,
  type StateMachineCheckReportV1,
} from 'archctx-contracts';
import projectionPrVerificationSchema from 'archctx-contracts/schemas/runtime/projection-pr-verification.schema.json';
import stateMachineCheckSchema from 'archctx-contracts/schemas/runtime/state-machine-check.schema.json';
import { isRecord } from '../evidence/is-record';
import {
  decodeArchitectureDebtReport,
  decodeConstraintEvaluation,
  decodeDocsAnchorsReport,
  decodeFlowSelectorCheck,
} from './projection';

export const ARCH_VERIFY_KIND = 'repo-harness.arch-verify';
export const ARCH_VERIFY_PROTOCOL = 1;

/** The checks `rh arch verify` runs, in report order. No write command is in this list. */
export const ARCH_VERIFY_CHECK_IDS = ['validate', 'flows', 'state-machines', 'constraints', 'docs', 'projection', 'debt'] as const;
export type ArchVerifyCheckId = (typeof ARCH_VERIFY_CHECK_IDS)[number];

export type ArchVerifyCheckStatus = 'pass' | 'findings' | 'error' | 'unavailable';
export type ArchVerifyVerdict = 'pass' | 'findings' | 'error';

export interface ArchVerifyCheckErrorV1 { readonly code: string; readonly message: string }

export interface ArchVerifyCheckV1 {
  readonly id: ArchVerifyCheckId;
  readonly status: ArchVerifyCheckStatus;
  /** The number of findings; 0 unless the status is `findings`. */
  readonly count: number;
  /** Present when the status is `error` or `unavailable`. */
  readonly error?: ArchVerifyCheckErrorV1;
}

export interface ArchVerifyReportV1 {
  readonly kind: typeof ARCH_VERIFY_KIND;
  readonly protocol: typeof ARCH_VERIFY_PROTOCOL;
  readonly base: string;
  readonly head: string;
  /** The pinned archctx version every check ran with. A package mismatch is an `error` check. */
  readonly archctx_version: string;
  readonly verdict: ArchVerifyVerdict;
  readonly checks: readonly ArchVerifyCheckV1[];
}

/**
 * The archctx codes that say the check could not observe its subject. Every other
 * failure, a timeout included, is an `error`: it says nothing about the change.
 */
export const ARCH_VERIFY_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'AC_MODEL_ADOPTION_REQUIRED',
  'AC_CODE_FACTS_UNAVAILABLE',
  'AC_CODE_FACTS_NOT_READY',
]);

/** The result of one archctx run: its envelope data, or the failure that stopped it. */
export type ArchVerifyCheckRead =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: ArchVerifyCheckErrorV1 };

/** One check's own answer, before a failed read or a decoder adds its status. */
type ArchVerifyFindings = { readonly status: 'pass' | 'findings' | 'unavailable'; readonly count: number; readonly error?: ArchVerifyCheckErrorV1 };

/** The code of a report that breaks the archctx contract this module decodes. */
export const ARCH_VERIFY_CONTRACT_CODE = 'RH_ARCH_VERIFY_CONTRACT_INVALID';

const findings = (count: number): ArchVerifyFindings => (count > 0 ? { status: 'findings', count } : { status: 'pass', count: 0 });
const unavailable = (code: string, message: string): ArchVerifyFindings => ({ status: 'unavailable', count: 0, error: { code, message } });

/**
 * One check's verdict from the producer's own gate and the problems this module
 * counted. A report that marks its own subject as not ok fails closed, also when
 * it names the reason in a field this module does not enumerate: `ok: false`
 * with nothing counted is one finding, never `pass`.
 */
function producerFindings(ok: boolean, counted: number): ArchVerifyFindings {
  return findings(counted > 0 ? counted : ok ? 0 : 1);
}

function decodeContract<T>(schema: unknown, value: unknown, label: string): T {
  const validation = validateJsonSchema(schema as Parameters<typeof validateJsonSchema>[0], value as Json);
  if (!validation.valid) {
    throw new Error(`${label} invalid: ${validation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return value as T;
}

/** `validate --format json`: one finding per error the model reports. */
function validateFindings(data: unknown): ArchVerifyFindings {
  if (!isRecord(data) || typeof data.valid !== 'boolean' || !Array.isArray(data.errors)
    || data.errors.some((entry) => typeof entry !== 'string')) {
    throw new Error('archctx validate returned no valid flag and error list');
  }
  // A model marked invalid without a named error is still one finding.
  return producerFindings(data.valid, data.errors.length);
}

/**
 * `flows check --no-sync`: one finding per selector that is not proven and per
 * diagnostic of a capability whose P2 proof is unprovable. The capability list is
 * a second authority: a flow fails on a missing relation, a duplicate participant
 * or a missing outcome while every declared selector is proven, and `ok` is false
 * for exactly that case. A capability without a diagnostic still counts once.
 */
function flowsFindings(data: unknown): ArchVerifyFindings {
  const report: ArchitectureFlowSelectorCheckV1 = decodeFlowSelectorCheck(data);
  if (report.codeGraph.availability !== 'ready') {
    return unavailable('AC_CODE_FACTS_UNAVAILABLE', 'the flows check read no CodeGraph code facts, so no flow proof was measured');
  }
  const unproven = report.selectors.filter((selector) => selector.status !== 'proven').length;
  const diagnostics = report.capabilities
    .filter((capability) => capability.p2Status === 'unprovable')
    .reduce((total, capability) => total + Math.max(capability.diagnostics.length, 1), 0);
  return producerFindings(report.ok, unproven + diagnostics);
}

/**
 * A code anchor that the repository does not provide. A digest that is merely
 * unconfirmed or changed is model maintenance: a code edit changes it normally,
 * and the ChangeSet that confirms the new digest owns it. `unchecked` and an
 * unsupported language are observation gaps, not disagreements.
 */
const STATE_MACHINE_ANCHOR_MISMATCH: ReadonlySet<StateMachineAnchorStatus> = new Set([
  'anchor-ambiguous-symbol',
  'anchor-missing-path',
  'anchor-missing-symbol',
]);
const STATE_MACHINE_ANCHOR_GAP: ReadonlySet<StateMachineAnchorStatus> = new Set(['unchecked', 'anchor-language-unsupported']);

/** `state-machines check`: one finding per rule that does not hold, per machine break and per missing anchor. */
function stateMachineFindings(data: unknown): ArchVerifyFindings {
  const report = decodeContract<StateMachineCheckReportV1>(stateMachineCheckSchema, data, 'state machine check report');
  let count = 0;
  for (const machine of report.machines) {
    count += machine.rules.filter((rule) => rule.status === 'broken' || rule.status === 'finding-open').length;
    count += machine.breaks.length;
    count += machine.anchors.filter((anchor) => STATE_MACHINE_ANCHOR_MISMATCH.has(anchor.status)).length;
  }
  if (count > 0) return findings(count);
  const gap = report.machines.flatMap((machine) => machine.anchors).find((anchor) => STATE_MACHINE_ANCHOR_GAP.has(anchor.status));
  if (gap) return unavailable('AC_CODE_FACTS_UNAVAILABLE', `the state-machine check left the ${gap.path} anchor unmeasured (${gap.status}${gap.reason ? `: ${gap.reason}` : ''})`);
  return findings(0);
}

/**
 * `constraints check`: one finding per violation and per import that resolved to
 * no file. `violated` with neither is the producer's own gate reporting a problem
 * this module did not enumerate, so it is one finding.
 */
function constraintFindings(data: unknown): ArchVerifyFindings {
  const report: DependencyConstraintEvaluationV1 = decodeConstraintEvaluation(data);
  const count = report.violations.length + report.unresolvedImports.length;
  if (count > 0) return findings(count);
  // A model that declares no dependency constraint has nothing to violate.
  if (report.status === 'not-applicable') return findings(0);
  if (report.status === 'undetermined' || report.coverage !== 'complete') {
    return unavailable('AC_CODE_FACTS_UNAVAILABLE', `the constraint check evaluated no complete import graph (${report.reasonCodes.join(', ') || report.coverage})`);
  }
  return producerFindings(report.status !== 'violated', 0);
}

/**
 * `docs anchors`: one finding per stale citation. A citation that could not be
 * resolved is a gap, so a partial read never becomes `pass`.
 */
function docsAnchorsFindings(data: unknown): ArchVerifyFindings {
  const report: DocsAnchorsReportV1 = decodeDocsAnchorsReport(data);
  if (report.summary.findings > 0) return findings(report.summary.findings);
  if (report.summary.unchecked > 0) {
    return unavailable('AC_CODE_FACTS_UNAVAILABLE', `the anchors check left ${report.summary.unchecked} citations unchecked`);
  }
  // Without code facts the check resolved no cited symbol, so it observed nothing.
  if (report.codeGraph.availability !== 'ready') {
    return unavailable('AC_CODE_FACTS_UNAVAILABLE', 'the anchors check read no CodeGraph code facts');
  }
  return findings(0);
}

/**
 * `projection verify-pr`: one finding per generated output that differs from a
 * fresh render, and per mixed-ownership target whose human-written text changed.
 * A change that touches non-generated paths is the normal case for code.
 */
function projectionFindings(data: unknown): ArchVerifyFindings {
  const report = decodeContract<ProjectionPrVerificationV1>(projectionPrVerificationSchema, data, 'projection verification report');
  const counted = report.differingPaths.length + report.humanEditedPaths.length;
  // A diff the producer could not prove render-equivalent is one finding by itself.
  const unproven = report.renderEquivalent === false && counted === 0 ? 1 : 0;
  return producerFindings(report.renderEquivalent !== false, counted + unproven);
}

/** `debt`: one finding per measured debt item. */
function debtFindings(data: unknown): ArchVerifyFindings {
  const report: ArchitectureDebtReportV1 = decodeArchitectureDebtReport(data);
  if (report.items.length > 0) return findings(report.items.length);
  if (report.coverage === 'unknown') {
    return unavailable('AC_CODE_FACTS_UNAVAILABLE', `the architecture debt measured nothing (${report.coverageReasonCodes.join(', ') || 'no reason code'})`);
  }
  return findings(0);
}

const CHECK_FINDINGS: Readonly<Record<ArchVerifyCheckId, (data: unknown) => ArchVerifyFindings>> = {
  validate: validateFindings,
  flows: flowsFindings,
  'state-machines': stateMachineFindings,
  constraints: constraintFindings,
  docs: docsAnchorsFindings,
  projection: projectionFindings,
  debt: debtFindings,
};

/** One check's status. A failed read keeps its own code; a decoder refusal is an `error`. */
export function archVerifyCheck(id: ArchVerifyCheckId, read: ArchVerifyCheckRead): ArchVerifyCheckV1 {
  if (!read.ok) {
    return { id, status: ARCH_VERIFY_UNAVAILABLE_CODES.has(read.error.code) ? 'unavailable' : 'error', count: 0, error: read.error };
  }
  try {
    const answer = CHECK_FINDINGS[id](read.data);
    return { id, status: answer.status, count: answer.count, ...(answer.error === undefined ? {} : { error: answer.error }) };
  } catch (error) {
    return {
      id, status: 'error', count: 0,
      error: { code: ARCH_VERIFY_CONTRACT_CODE, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * `error` outranks `findings`, and one `unavailable` check never changes the
 * verdict: a mixed pass/unavailable result stays `pass`, as the issue defines.
 * A `pass` verdict needs one measured check, so a run in which every check is
 * unavailable is `error`: nothing observed the change.
 */
export function archVerifyVerdict(checks: readonly ArchVerifyCheckV1[]): ArchVerifyVerdict {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'findings')) return 'findings';
  return checks.some((check) => check.status === 'pass') ? 'pass' : 'error';
}

export function archVerifyExitCode(verdict: ArchVerifyVerdict): 0 | 1 | 2 {
  return verdict === 'pass' ? 0 : verdict === 'findings' ? 1 : 2;
}

export interface ArchVerifyInput {
  readonly base: string;
  readonly head: string;
  readonly archctxVersion: string;
  readonly reads: readonly { readonly id: ArchVerifyCheckId; readonly read: ArchVerifyCheckRead }[];
}

/** The one document, with the checks in report order whatever order the reads arrived in. */
export function buildArchVerifyReport(input: ArchVerifyInput): ArchVerifyReportV1 {
  const byId = new Map(input.reads.map((entry) => [entry.id, entry.read] as const));
  const checks = ARCH_VERIFY_CHECK_IDS.map((id) => archVerifyCheck(id, byId.get(id) ?? {
    ok: false,
    error: { code: ARCH_VERIFY_CONTRACT_CODE, message: `the ${id} check did not run` },
  }));
  return {
    kind: ARCH_VERIFY_KIND, protocol: ARCH_VERIFY_PROTOCOL,
    base: input.base, head: input.head, archctx_version: input.archctxVersion,
    verdict: archVerifyVerdict(checks), checks,
  };
}

/** One line per check, then the verdict. */
export function formatArchVerifyText(report: ArchVerifyReportV1): string {
  return `${[
    ...report.checks.map((check) => `${check.id}  ${check.status}  ${check.count}`),
    `verdict  ${report.verdict}`,
  ].join('\n')}\n`;
}
