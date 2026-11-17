import { observationReadFileSync as readFileSync } from '../readonly-observation';
import { existsSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { canonicalize } from "../../core/evidence/canonical-json";
import { SHA256_PREFIXED_PATTERN } from "../../core/evidence/sha256-pattern";
import { sha256Prefixed } from "../../core/evidence/sha256";
import type { EvidenceEventRecord, GenesisRecord, JsonValue, AdmittedReviewSubjectIdentity, EvalCatalogSubjectIdentity } from "../../core/evidence/types";
import { redactPayloadStrings } from "../../core/evidence/redaction";
import {
  fingerprintVerificationCheck,
  fingerprintVerificationCheckExecution,
  hashVerificationPlan,
  type VerificationCheck,
} from "../../core/evidence/verification-plan";
import { observeActiveReviewAdmission } from "../admission/issue-goal";
import { resolveInsideRepo } from "../path-safety";
import { resolveBlobsDir } from "./paths";
import { readAcceptedEvents, readGenesisRecord } from "./event-log";
import { collectDenylistSecretValues } from "./secret-env";
import {
  cacheKey,
  cacheKeyFromIdentity,
  declaredEnvironmentHash,
  displayCommand,
  resolveToolchain,
  type AuthorityBinding,
  type EvidenceContext,
  type PreparedContext,
  type ReviewBinding,
} from "./verification-toolchain";

export const EVENT_TYPE = "verification_execution.result";
export const PRODUCER = "verification-execution";

export type VerificationExecutionState = "executed" | "reused" | "baseline" | "missing";
export type VerificationReportStatus = "passed" | "failed" | "missing" | "needs_verification_plan" | "waiting";

export interface VerificationExecutionResult {
  readonly id: string;
  readonly kind: VerificationCheck["kind"];
  readonly target: "current_exact" | "historical_baseline_with_current_delta";
  readonly passed: boolean;
  readonly message: string;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly execution: VerificationExecutionState;
  readonly cache_key: string;
  readonly command: string;
  readonly force_reason: string | null;
  readonly execution_id: string | null;
  readonly run_file: string | null;
  readonly failure_log_file: string | null;
}

export interface VerificationEvaluation {
  readonly requirements_hash: string;
  readonly snapshot_hash: string;
  readonly exact_passed: number;
  readonly baseline_passed: number;
  readonly unmet_check_ids: readonly string[];
  readonly snapshot_changed_during_execution: boolean;
}

export interface VerificationExecutionReport {
  readonly protocol: 2;
  readonly kind: "verification_execution_report";
  readonly target: {
    readonly campaign_sha256: string;
    readonly admission_sha256: string;
    readonly grant_sha256: string;
    readonly plan_hash: string;
    readonly snapshot_hash: string;
    readonly tree_hash: string;
    readonly head_commit: string;
  };
  readonly passed: boolean;
  readonly status: VerificationReportStatus;
  readonly evaluation: VerificationEvaluation;
  readonly results: readonly VerificationExecutionResult[];
}

export interface EvalExecutionReport extends Omit<VerificationExecutionReport, "kind" | "target"> {
  readonly kind: "eval_execution_report";
  readonly target: {
    readonly catalog_sha256: string;
    readonly eval_id: string;
    readonly eval_sha256: string;
    readonly plan_hash: string;
    readonly snapshot_hash: string;
    readonly tree_hash: string;
    readonly head_commit: string;
  };
}
export type ExecutionReport = VerificationExecutionReport | EvalExecutionReport;

export type VerificationOutcome = VerificationExecutionReport;

export type ReviewAdmissionSource = Parameters<typeof observeActiveReviewAdmission>[0];

export interface VerificationInput {
  readonly repoRoot: string;
  readonly authority: ReviewAdmissionSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface VerificationExecutionReportValidation {
  readonly valid: true;
  readonly report: VerificationExecutionReport;
}

export type ExecutionPayload = AuthorityBinding & {
  readonly protocol: 2;
  readonly plan_hash: string;
  readonly check_id: string;
  readonly check_fingerprint: string;
  readonly execution_spec_hash: string;
  readonly inputs_hash: string;
  readonly toolchain_hash: string;
  readonly snapshot_hash: string;
  readonly cache_key: string;
  readonly execution_id: string;
  readonly run_file: string;
  readonly run_record_hash: string;
  readonly passed: boolean;
}

export function readAdmission(input: Pick<VerificationInput, "repoRoot" | "authority">) {
  if (realpathSync(input.repoRoot) !== realpathSync(input.authority.repoRoot)) {
    throw new Error("verification admission repository does not match execution repository");
  }
  return observeActiveReviewAdmission(input.authority);
}

export function admittedIdentity(active: ReturnType<typeof observeActiveReviewAdmission>) {
  return { campaign_sha256: active.admission.campaign_sha256,
    admission_sha256: active.admission.admission_sha256, grant_sha256: active.grant_sha256 };
}

export function reviewAuthority(input: Pick<VerificationInput, "repoRoot" | "authority">) {
  const active = readAdmission(input);
  const binding: ReviewBinding = { authority_kind: "review-admission", ...admittedIdentity(active) };
  return { binding, plan: active.admission.verification_plan, assertCurrent: () => {
    const current = readAdmission(input);
    if (current.revision !== active.revision
      || canonicalize(admittedIdentity(current)) !== canonicalize(admittedIdentity(active))) {
      throw new Error("verification admission changed during evaluation");
    }
  } };
}

function authorityBinding(identity: AdmittedReviewSubjectIdentity | EvalCatalogSubjectIdentity | ExecutionPayload): AuthorityBinding {
  return identity.authority_kind === "review-admission"
    ? { authority_kind: identity.authority_kind, campaign_sha256: identity.campaign_sha256,
        admission_sha256: identity.admission_sha256, grant_sha256: identity.grant_sha256 }
    : { authority_kind: identity.authority_kind, catalog_sha256: identity.catalog_sha256,
        eval_id: identity.eval_id, eval_sha256: identity.eval_sha256 };
}

function sameAuthority(left: AuthorityBinding, right: AuthorityBinding): boolean {
  return canonicalize(left) === canonicalize(right);
}

function payloadOf(repoRoot: string, event: EvidenceEventRecord): ExecutionPayload | null {
  let value: unknown = event.payload;
  if (value === undefined && event.blob_sha256) {
    try {
      value = JSON.parse(readFileSync(join(resolveBlobsDir(repoRoot), event.blob_sha256), "utf8"));
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const authorityHashes = record.authority_kind === "review-admission"
    ? [record.campaign_sha256, record.admission_sha256, record.grant_sha256]
    : record.authority_kind === "eval-catalog" && typeof record.eval_id === "string" && record.eval_id.length > 0
      ? [record.catalog_sha256, record.eval_sha256] : [];
  if (record.protocol !== 2 || !authorityHashes.length
    || ![...authorityHashes, record.plan_hash].every(value => typeof value === "string" && SHA256_PREFIXED_PATTERN.test(value))
    || typeof record.check_id !== "string") return null;
  if (typeof record.cache_key !== "string" || typeof record.execution_id !== "string" || typeof record.run_file !== "string") return null;
  if (typeof record.run_record_hash !== "string" || typeof record.passed !== "boolean") return null;
  if (typeof record.inputs_hash !== "string" || typeof record.toolchain_hash !== "string") return null;
  return record as unknown as ExecutionPayload;
}

function executionEvents(context: EvidenceContext): readonly { event: EvidenceEventRecord; payload: ExecutionPayload }[] {
  return readAcceptedEvents(context.repoRoot).accepted.flatMap((event) => {
    if (event.event_type !== EVENT_TYPE || event.producer !== PRODUCER || event.trust_class !== "authoritative_machine") return [];
    const payload = payloadOf(context.repoRoot, event);
    if (!payload || payload.authority_kind !== context.binding.authority_kind) return [];
    // Review history is campaign-scoped only for explicit baseline references.
    // Exact matching below still requires the current admission and grant.
    if (payload.authority_kind === "review-admission" && context.binding.authority_kind === "review-admission") {
      if (payload.campaign_sha256 !== context.binding.campaign_sha256) return [];
    } else if (!sameAuthority(authorityBinding(payload), context.binding)) return [];
    const identity = event.subject_identity;
    if (!("authority_kind" in identity)
      || !sameAuthority(authorityBinding(identity), authorityBinding(payload))
      || identity.plan_hash !== payload.plan_hash
      || identity.scope_hash !== payload.plan_hash
      || identity.subject_hash !== payload.snapshot_hash
      || identity.command_hash !== payload.check_fingerprint
      || identity.env_provider_id !== `verification-execution/${payload.toolchain_hash}`
      || identity.authority_commit !== identity.base_commit
      || sha256Prefixed(canonicalize({ tree_hash: identity.target_commit })) !== payload.snapshot_hash) return [];
    return [{ event, payload }];
  });
}

interface LedgerView {
  readonly events: readonly { event: EvidenceEventRecord; payload: ExecutionPayload }[];
  readonly genesis: GenesisRecord | null;
}

/**
 * Reads the ledger at most once, on first use. Share one view only between
 * checks with no append between them; take a new view after an append.
 */
export function ledgerView(context: EvidenceContext): LedgerView {
  let events: LedgerView["events"] | undefined;
  let genesis: { readonly value: GenesisRecord | null } | undefined;
  return {
    get events() { return events ??= executionEvents(context); },
    get genesis() { return (genesis ??= { value: readGenesisRecord(context.repoRoot) }).value; },
  };
}

function readValidRunResult(context: EvidenceContext, payload: ExecutionPayload): VerificationExecutionResult | null {
  if (!payload.run_file.startsWith(".ai/harness/runs/")) return null;
  const resolved = resolveInsideRepo(context.repoRoot, payload.run_file);
  if (!resolved.ok || !resolved.path || !existsSync(resolved.path)) return null;
  try {
    const bytes = readFileSync(resolved.path);
    if (sha256Prefixed(bytes) !== payload.run_record_hash) return null;
    const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (!(record.protocol === 1
      && record.kind === "verification_execution_record"
      && record.execution_id === payload.execution_id
      && record.cache_key === payload.cache_key
      && typeof record.result === "object"
      && record.result !== null
      && !Array.isArray(record.result))) return null;
    const result = record.result as unknown as VerificationExecutionResult;
    return result.passed === payload.passed ? result : null;
  } catch {
    return null;
  }
}

export function currentResult(context: PreparedContext, check: VerificationCheck, ledger: LedgerView): VerificationExecutionResult | null {
  const key = cacheKey(context, check);
  const matches = ledger.events.filter(({ payload }) => payload.cache_key === key);
  const winner = matches[matches.length - 1];
  if (!winner) return null;
  const result = readValidRunResult(context, winner.payload);
  if (!result || result.id !== check.id) return null;
  if (!result.passed && result.exit_code === 0 && !result.timed_out && result.signal === null) return null;
  const projected = { ...result, execution: result.passed ? "reused" as const : "executed" as const };
  const materialized = (redactPayloadStrings({ result: projected } as unknown as JsonValue, collectDenylistSecretValues()) as unknown as { result: VerificationExecutionResult }).result;
  return matchingImmutableExecution(context, check, materialized, false, context.toolchainHash, ledger) ? projected : null;
}

export function reusableResult(context: PreparedContext, check: VerificationCheck, ledger: LedgerView): VerificationExecutionResult | null {
  const result = currentResult(context, check, ledger);
  return result?.passed ? result : null;
}

export function priorExecutionExists(context: PreparedContext, check: VerificationCheck, ledger: LedgerView): boolean {
  return ledger.events.some(({ payload }) =>
    payload.execution_spec_hash === fingerprintVerificationCheckExecution(check));
}

export function baselineResult(
  context: EvidenceContext,
  check: VerificationCheck,
  current: ReadonlyMap<string, VerificationExecutionResult>,
  ledger: LedgerView,
): VerificationExecutionResult {
  const key = sha256Prefixed(canonicalize({
    policy: "baseline_with_delta",
    plan_hash: context.planHash,
    snapshot_hash: context.snapshot.snapshot_hash,
    execution_spec_hash: fingerprintVerificationCheckExecution(check),
    baseline: check.baseline ?? null,
    delta: (check.delta_checks ?? []).map((id) => ({ id, cache_key: current.get(id)?.cache_key ?? null })),
  } as unknown as JsonValue));
  const base = {
    id: check.id,
    kind: check.kind,
    target: "historical_baseline_with_current_delta" as const,
    duration_ms: 0,
    timed_out: false,
    exit_code: null,
    signal: null,
    execution: "missing" as VerificationExecutionState,
    cache_key: key,
    command: displayCommand(check),
    force_reason: null,
    execution_id: check.baseline?.execution_id ?? null,
    run_file: check.baseline?.run_file ?? null,
    failure_log_file: null,
  };
  if (!check.baseline || !check.delta_checks) return { ...base, passed: false, message: "baseline reference is incomplete" };
  const events = ledger.events;
  const eventMatch = events.find(({ payload }) =>
    payload.execution_id === check.baseline!.execution_id
      && payload.run_file === check.baseline!.run_file
      && payload.execution_spec_hash === fingerprintVerificationCheckExecution(check)
      && payload.passed
      && readValidRunResult(context, payload)?.passed === true);
  if (!eventMatch) return { ...base, passed: false, message: "baseline execution is missing, failed, forged, or stale" };
  const sameInput = events.filter(({ payload }) => payload.cache_key === eventMatch.payload.cache_key);
  const latest = sameInput[sameInput.length - 1];
  if (!latest?.payload.passed || readValidRunResult(context, latest.payload)?.passed !== true) {
    return { ...base, passed: false, message: "baseline is superseded because a newer execution failed or is invalid" };
  }
  const unmet = check.delta_checks.filter((id) => current.get(id)?.passed !== true);
  if (unmet.length > 0) return { ...base, passed: false, message: `current delta checks are unsatisfied: ${unmet.join(", ")}` };
  return {
    ...base,
    passed: true,
    message: `historical baseline ${check.baseline.execution_id} retained with current delta checks`,
    execution: "baseline",
  };
}

function skippedResult(check: VerificationCheck, message: string, key: string): VerificationExecutionResult {
  return {
    id: check.id,
    kind: check.kind,
    target: "current_exact",
    passed: false,
    message,
    duration_ms: 0,
    timed_out: false,
    exit_code: null,
    signal: null,
    execution: "missing",
    cache_key: key,
    command: displayCommand(check),
    force_reason: null,
    execution_id: null,
    run_file: null,
    failure_log_file: null,
  };
}

export function missingResult(context: PreparedContext, check: VerificationCheck, message: string): VerificationExecutionResult {
  return skippedResult(check, message, cacheKey(context, check));
}

/** A skipped result claims no execution, so only its exact materialized shape is valid. */
function isMaterializedSkippedResult(check: VerificationCheck, result: VerificationExecutionResult): boolean {
  if (typeof result.message !== "string" || typeof result.cache_key !== "string") return false;
  const expected = (redactPayloadStrings(
    { result: skippedResult(check, result.message, result.cache_key) } as unknown as JsonValue,
    collectDenylistSecretValues(),
  ) as unknown as { result: JsonValue }).result;
  return canonicalize(result as unknown as JsonValue) === canonicalize(expected);
}

export function buildReport(
  context: EvidenceContext,
  results: readonly VerificationExecutionResult[],
  status: VerificationReportStatus,
  snapshotChanged = false,
): ExecutionReport {
  const shared = {
    protocol: 2 as const,
    target: {
      plan_hash: context.planHash,
      snapshot_hash: context.snapshot.snapshot_hash,
      tree_hash: context.snapshot.tree_hash,
      head_commit: context.snapshot.head_commit,
    },
    passed: status === "passed",
    status,
    evaluation: {
      requirements_hash: context.planHash,
      snapshot_hash: context.snapshot.snapshot_hash,
      exact_passed: results.filter((result) => result.passed && result.target === "current_exact").length,
      baseline_passed: results.filter((result) => result.passed && result.execution === "baseline").length,
      unmet_check_ids: results.filter((result) => !result.passed).map((result) => result.id),
      snapshot_changed_during_execution: snapshotChanged,
    },
    results,
  };
  if (context.binding.authority_kind === "review-admission") {
    const review = context.binding;
    return { ...shared, kind: "verification_execution_report", target: { ...shared.target,
      campaign_sha256: review.campaign_sha256, admission_sha256: review.admission_sha256, grant_sha256: review.grant_sha256 } };
  }
  const evaluation = context.binding;
  return { ...shared, kind: "eval_execution_report", target: { ...shared.target,
    catalog_sha256: evaluation.catalog_sha256, eval_id: evaluation.eval_id, eval_sha256: evaluation.eval_sha256 } };
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function materializedVerificationCheckId(id: string): string {
  const projected = redactPayloadStrings({
    execution_evaluation: { results: [{ id }] },
  } as unknown as JsonValue, collectDenylistSecretValues()) as {
    readonly execution_evaluation: { readonly results: readonly [{ readonly id: string }] };
  };
  return projected.execution_evaluation.results[0].id;
}

/** `currentToolchainHash` is null for historical proof, which uses the event's self-bound toolchain identity. */
function matchingImmutableExecution(
  context: EvidenceContext,
  check: VerificationCheck,
  result: VerificationExecutionResult,
  requirePass: boolean,
  currentToolchainHash: string | null,
  ledger: LedgerView,
): boolean {
  return ledger.events.some(({ event, payload }) => {
    if (currentToolchainHash !== null && (payload.toolchain_hash !== currentToolchainHash
      || payload.inputs_hash !== declaredEnvironmentHash(check, context.env))) return false;
    if (!sameAuthority(authorityBinding(payload), context.binding)) return false;
    if (payload.check_id !== check.id
      || payload.plan_hash !== context.planHash
      || payload.check_fingerprint !== fingerprintVerificationCheck(check)
      || payload.execution_spec_hash !== fingerprintVerificationCheckExecution(check)
      || payload.snapshot_hash !== context.snapshot.snapshot_hash
      || payload.cache_key !== result.cache_key
      || payload.execution_id !== result.execution_id
      || payload.run_file !== result.run_file
      || (requirePass && !payload.passed)) return false;
    const genesis = ledger.genesis;
    if (!genesis || event.worktree_id !== genesis.worktree_id) return false;
    const identity = event.subject_identity;
    if (!("authority_kind" in identity)
      || !sameAuthority(authorityBinding(identity), authorityBinding(payload))
      || identity.authority_commit !== identity.base_commit
      || identity.target_commit !== context.snapshot.tree_hash
      || identity.scope_hash !== payload.plan_hash
      || identity.subject_hash !== payload.snapshot_hash
      || identity.plan_hash !== payload.plan_hash
      || identity.command_hash !== payload.check_fingerprint
      || identity.env_provider_id !== `verification-execution/${payload.toolchain_hash}`) return false;
    const selfBoundCacheKey = cacheKeyFromIdentity({
      check,
      snapshotHash: payload.snapshot_hash,
      toolchainHash: payload.toolchain_hash,
      inputsHash: payload.inputs_hash,
    });
    if (selfBoundCacheKey !== payload.cache_key) return false;
    const stored = readValidRunResult(context, payload);
    if (!stored || (requirePass && !stored.passed)) return false;
    const normalized = { ...result, execution: "executed" as const };
    const ledgerProjection = (redactPayloadStrings(
      { result: stored } as unknown as JsonValue,
      collectDenylistSecretValues(),
    ) as unknown as { result: JsonValue }).result;
    return canonicalize(normalized as unknown as JsonValue) === canonicalize(ledgerProjection);
  });
}

/**
 * Validate a ledger-writer-projected report against immutable run evidence.
 * Callers must supply the materialized representation consumed by receipts,
 * after the evidence writer's canonical redaction pass. Raw execute/evaluate
 * output containing entropy-redacted leaves is outside this API boundary.
 * The report's frozen snapshot is verified while the current checkout may
 * have moved because receipt/archive readers consume historical facts.
 */
interface MaterializedVerificationInput {
  readonly repoRoot: string;
  readonly authority: ReviewAdmissionSource;
  readonly report: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly current?: boolean;
}

export function validateMaterializedVerificationExecutionReport(input: MaterializedVerificationInput): VerificationExecutionReportValidation {
  return validateMaterializedOutcome(input, true);
}

/** Observer admission retains negative immutable outcomes without granting a pass. */
export function validateMaterializedVerificationExecutionOutcome(input: MaterializedVerificationInput): VerificationExecutionReportValidation {
  return validateMaterializedOutcome(input, false);
}

function validateMaterializedOutcome(input: MaterializedVerificationInput, requirePass: boolean): VerificationExecutionReportValidation {
  const reportObject = objectValue(input.report, "verification report");
  if (reportObject.protocol !== 2 || reportObject.kind !== "verification_execution_report") {
    throw new Error("verification report protocol or kind is invalid");
  }
  if (requirePass && (reportObject.status !== "passed" || reportObject.passed !== true)) {
    throw new Error("verification report is not a passing evaluation");
  }
  const target = objectValue(reportObject.target, "verification report target");
  const treeHash = stringValue(target.tree_hash, "verification report target.tree_hash");
  const snapshotHash = stringValue(target.snapshot_hash, "verification report target.snapshot_hash");
  if (snapshotHash !== sha256Prefixed(canonicalize({ tree_hash: treeHash }))) throw new Error("verification report snapshot hash is invalid");

  const repoRoot = resolve(input.repoRoot);
  const admission = readAdmission(input);
  for (const [key, value] of Object.entries(admittedIdentity(admission))) {
    if (target[key] !== value) throw new Error(`verification report ${key} does not match admitted authority`);
  }
  const plan = admission.admission.verification_plan;
  const planHash = hashVerificationPlan(plan);
  if (target.plan_hash !== planHash) throw new Error("verification report plan hash does not match admitted authority");
  const env = input.env ?? process.env;
  const currentToolchainHash = input.current ? resolveToolchain(env).hash : null;
  const context: EvidenceContext = {
    repoRoot, binding: { authority_kind: "review-admission", ...admittedIdentity(admission) },
    assertCurrent: () => {
      const current = readAdmission(input);
      if (current.revision !== admission.revision || !sameAuthority(
        { authority_kind: "review-admission", ...admittedIdentity(current) },
        { authority_kind: "review-admission", ...admittedIdentity(admission) })) throw new Error("verification admission changed during evaluation");
    }, plan, planHash,
    snapshot: {
      head_commit: stringValue(target.head_commit, "verification report target.head_commit"),
      tree_hash: treeHash,
      snapshot_hash: snapshotHash,
    },
    env,
  };
  const ledger = ledgerView(context);
  if (!Array.isArray(reportObject.results) || reportObject.results.length !== plan.checks.length) {
    throw new Error("verification report results do not cover the plan exactly");
  }
  const expectedByMaterializedId = new Map<string, VerificationCheck>();
  for (const check of plan.checks) {
    const materializedId = materializedVerificationCheckId(check.id);
    if (expectedByMaterializedId.has(materializedId)) {
      throw new Error("verification report result ids are ambiguous after materialization");
    }
    expectedByMaterializedId.set(materializedId, check);
  }
  const supplied = new Map<string, VerificationExecutionResult>();
  for (const raw of reportObject.results) {
    const candidate = objectValue(raw, "verification report result") as unknown as VerificationExecutionResult;
    if (typeof candidate.id !== "string") throw new Error("verification report result ids are missing or invalid");
    const check = expectedByMaterializedId.get(candidate.id);
    if (!check) throw new Error(`verification report result id is unknown: ${candidate.id}`);
    if (supplied.has(check.id)) throw new Error("verification report result ids are duplicated");
    supplied.set(check.id, candidate);
  }
  if (supplied.size !== plan.checks.length) {
    throw new Error("verification report result ids do not cover the plan exactly");
  }
  for (const check of plan.checks) {
    const result = supplied.get(check.id);
    if (!result || result.kind !== check.kind || typeof result.passed !== "boolean" || (requirePass && result.passed !== true)) throw new Error(`verification report result is invalid: ${check.id}`);
    if (check.evidence_policy === "current_exact") {
      // A failed preflight skips later checks. Those skipped results must not
      // remove the authority of the recorded failure from a negative outcome.
      const skipped = !requirePass && result.execution === "missing" && isMaterializedSkippedResult(check, result);
      if (result.target !== "current_exact" || (!skipped && result.execution !== "executed" && result.execution !== "reused")) {
        throw new Error(`verification report exact result has invalid disposition: ${check.id}`);
      }
      if (!skipped && !matchingImmutableExecution(context, check, result, requirePass, currentToolchainHash, ledger)) {
        throw new Error(`verification report exact result is not backed by immutable evidence: ${check.id}`);
      }
    }
  }
  for (const check of plan.checks) {
    if (check.evidence_policy !== "baseline_with_delta") continue;
    const result = supplied.get(check.id)!;
    const evaluated = baselineResult(context, check, supplied, ledger);
    if (requirePass && !evaluated.passed) {
      throw new Error(`verification report baseline result is not backed by immutable evidence: ${check.id}`);
    }
    const projectedExpected = (redactPayloadStrings(
      { result: evaluated } as unknown as JsonValue,
      collectDenylistSecretValues(),
    ) as unknown as { result: JsonValue }).result;
    if (canonicalize(result as unknown as JsonValue) !== canonicalize(projectedExpected)) {
      throw new Error(`verification report baseline result was altered: ${check.id}`);
    }
  }
  const results = plan.checks.map((check) => supplied.get(check.id)!);
  const expected = buildReport(context, results, results.every(result => result.passed) ? "passed" : "failed", false);
  if (!requirePass && (reportObject.status !== expected.status || reportObject.passed !== expected.passed)) throw new Error("verification report outcome is inconsistent");
  const evaluation = objectValue(reportObject.evaluation, "verification report evaluation");
  const projectedEvaluation = redactPayloadStrings(
    expected.evaluation as unknown as JsonValue,
    collectDenylistSecretValues(),
  );
  if (canonicalize(evaluation as JsonValue) !== canonicalize(projectedEvaluation)) {
    throw new Error("verification report evaluation metadata is inconsistent");
  }
  context.assertCurrent();
  return { valid: true, report: input.report as VerificationExecutionReport };
}

export function verificationOutcomeProvenance(input: MaterializedVerificationInput, checkId: string) {
  const { report } = validateMaterializedVerificationExecutionOutcome(input);
  const plan = readAdmission(input).admission.verification_plan;
  const result = report.results.find(item => item.id === materializedVerificationCheckId(checkId));
  if (!result) throw new Error("verification check is absent");
  const events = readAcceptedEvents(input.repoRoot).accepted;
  const offset = events.slice().reverse().findIndex(event => {
    const payload = payloadOf(input.repoRoot, event);
    return event.event_type === EVENT_TYPE && event.producer === PRODUCER
      && payload?.authority_kind === "review-admission"
      && payload.campaign_sha256 === report.target.campaign_sha256
      && payload?.execution_id === result.execution_id
      && payload.check_id === checkId
      && payload.cache_key === result.cache_key;
  });
  if (offset < 0) throw new Error("verification sequence is unavailable");
  const index = events.length - 1 - offset;
  const payload = payloadOf(input.repoRoot, events[index]!)!;
  if (payload.authority_kind !== "review-admission") throw new Error("review authority required");
  return { report, result, execution_order: index + 1,
    environment: `verification-execution/${payload.toolchain_hash}`,
    admission_identity: payload.admission_sha256,
    grant_identity: payload.grant_sha256,
    campaign_identity: payload.campaign_sha256,
    check_set_identity: sha256Prefixed(canonicalize(plan.checks.map(check => check.id))),
  };
}
