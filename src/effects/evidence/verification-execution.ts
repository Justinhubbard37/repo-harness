import { randomUUID } from "crypto";
import { isAbsolute, resolve } from "path";

import { canonicalize } from "../../core/evidence/canonical-json";
import { sha256Prefixed } from "../../core/evidence/sha256";
import type { JsonValue, AdmittedReviewSubjectIdentity, EvalCatalogSubjectIdentity } from "../../core/evidence/types";
import { redactPayloadStrings } from "../../core/evidence/redaction";
import {
  fingerprintVerificationCheck,
  fingerprintVerificationCheckExecution,
  hashVerificationPlan,
  type VerificationCheck,
  type VerificationPlan,
} from "../../core/evidence/verification-plan";
import { readEvalCatalogPlan, type EvalCatalogSource } from "./eval-catalog";
import { resolveGitCommonDirectory } from "../git/common-directory";
import { acquireExclusiveDirectoryLock, ExclusiveLockContentionError } from "../locking/exclusive-directory-lock";
import { resolveInsideRepo } from "../path-safety";
import { runProcess } from "../process-runner";
import { createFileExclusiveDurably, writeFileDurably } from "../atomic-append";
import { LEDGER_EPOCH_START_SHA } from "./epoch";
import { appendEvidenceEvent, appendGenesisRecord, readGenesisRecord } from "./event-log";
import { collectDenylistSecretValues } from "./secret-env";
import {
  cacheKey,
  captureGitVirtualTreeSnapshot,
  declaredEnvironmentHash,
  redactKnownEnvironmentValues,
  resolveExecutionCwd,
  resolvePackageTest,
  resolveToolchain,
  verificationChildEnv,
  type EvidenceContext,
  type PreparedContext,
  type EvalBinding,
} from "./verification-toolchain";
import {
  EVENT_TYPE,
  PRODUCER,
  admittedIdentity,
  baselineResult,
  buildReport,
  currentResult,
  ledgerView,
  missingResult,
  priorExecutionExists,
  readAdmission,
  reusableResult,
  reviewAuthority,
  type ExecutionPayload,
  type ExecutionReport,
  type VerificationExecutionResult,
  type VerificationReportStatus,
  type VerificationExecutionReport,
  type EvalExecutionReport,
  type VerificationInput,
  type VerificationOutcome,
} from "./verification-ledger-view";

export { captureGitVirtualTreeSnapshot } from "./verification-toolchain";
export type { GitVirtualTreeSnapshot } from "./verification-toolchain";
export {
  validateMaterializedVerificationExecutionReport,
  validateMaterializedVerificationExecutionOutcome,
  verificationOutcomeProvenance,
} from "./verification-ledger-view";
export type {
  VerificationExecutionState,
  VerificationReportStatus,
  VerificationExecutionResult,
  VerificationEvaluation,
  VerificationExecutionReport,
  EvalExecutionReport,
  VerificationOutcome,
  ReviewAdmissionSource,
  VerificationInput,
  VerificationExecutionReportValidation,
} from "./verification-ledger-view";

const REQUEST_LOCK_ROOT = "repo-harness/verification-execution";
const VERIFICATION_DIAGNOSTIC_MAX_BYTES = 16 * 1024 * 1024;

export interface ExecuteAdmittedVerificationInput extends VerificationInput {
  readonly reportFile?: string;
  readonly forceReason?: string;
}

export interface AdmittedVerificationValidation {
  readonly protocol: 2;
  readonly kind: "verification_plan_validation";
  readonly valid: true;
  readonly campaign_sha256: string;
  readonly admission_sha256: string;
  readonly grant_sha256: string;
  readonly plan_hash: string;
  readonly plan: VerificationPlan;
}


function prepareContext(input: Pick<VerificationInput, "repoRoot" | "env">,
  authority: Pick<EvidenceContext, "binding" | "plan" | "assertCurrent">): PreparedContext {
  const repoRoot = resolve(input.repoRoot);
  const env = input.env ?? process.env;
  const toolchain = resolveToolchain(env);
  return { repoRoot, ...authority, planHash: hashVerificationPlan(authority.plan),
    snapshot: captureGitVirtualTreeSnapshot(repoRoot), env,
    toolchainHash: toolchain.hash, envProviderId: toolchain.providerId };
}

function prepare(input: VerificationInput): PreparedContext {
  return prepareContext(input, reviewAuthority(input));
}

export function validateAdmittedVerification(
  input: Pick<VerificationInput, "repoRoot" | "authority">,
): AdmittedVerificationValidation {
  const admission = readAdmission(input);
  const plan = admission.admission.verification_plan;
  return { protocol: 2, kind: "verification_plan_validation", valid: true,
    ...admittedIdentity(admission), plan_hash: hashVerificationPlan(plan), plan };
}


function evaluatePrepared(context: PreparedContext): ExecutionReport {
  const ledger = ledgerView(context);
  const current = new Map<string, VerificationExecutionResult>();
  for (const check of context.plan.checks) {
    if (check.evidence_policy !== "current_exact") continue;
    current.set(check.id, currentResult(context, check, ledger) ?? missingResult(context, check, "current exact execution is missing"));
  }
  const results = context.plan.checks.map((check) => check.evidence_policy === "current_exact"
    ? current.get(check.id)!
    : baselineResult(context, check, current, ledger));
  return buildReport(context, results, results.every((result) => result.passed) ? "passed"
    : results.some(result => result.execution === "executed" && !result.passed) ? "failed" : "missing");
}

/** Read-only evidence evaluation. This function never invokes a check command. */
export function evaluateAdmittedVerification(input: VerificationInput): VerificationOutcome {
  const context = prepare(input);
  const report = evaluatePrepared(context);
  if (report.kind !== "verification_execution_report") throw new Error("review authority required");
  if (report.passed) context.assertCurrent();
  return report;
}

function subjectIdentity(context: PreparedContext, check: VerificationCheck): AdmittedReviewSubjectIdentity | EvalCatalogSubjectIdentity {
  return {
    authority_commit: context.snapshot.head_commit,
    base_commit: context.snapshot.head_commit,
    target_commit: context.snapshot.tree_hash,
    scope_hash: context.planHash,
    subject_hash: context.snapshot.snapshot_hash,
    ...context.binding,
    plan_hash: context.planHash,
    command_hash: fingerprintVerificationCheck(check),
    env_provider_id: context.envProviderId,
  };
}

function ensureGenesis(context: PreparedContext): void {
  if (readGenesisRecord(context.repoRoot)) return;
  const worktreeId = `verification-${sha256Prefixed(canonicalize(context.binding)).slice(7, 27)}`;
  appendGenesisRecord(context.repoRoot, LEDGER_EPOCH_START_SHA, { worktreeId });
}

interface ExecutedCheckOutcome {
  readonly result: VerificationExecutionResult;
  readonly snapshotStable: boolean;
}

function executeCheck(
  context: PreparedContext,
  check: VerificationCheck,
  input: ExecutionOptions,
  deadlineMs: number,
): ExecutedCheckOutcome | "waiting" {
  const key = cacheKey(context, check);
  const commonDir = resolveGitCommonDirectory(context.repoRoot, context.env.REPO_HARNESS_GIT_BIN || "git");
  let requestLock;
  try {
    requestLock = acquireExclusiveDirectoryLock(commonDir, `${REQUEST_LOCK_ROOT}/${key.slice("sha256:".length)}.lock`, {
      waitTimeoutMs: 1,
      reclaimStaleOwner: true,
      reclaimStaleEmptyDirectory: true,
    });
  } catch (error) {
    if (error instanceof ExclusiveLockContentionError) return "waiting";
    throw error;
  }
  try {
    requestLock.assertOwned();
    // Another writer can append before this lock is held, so read a new view.
    const afterLock = input.forceReason ? null : reusableResult(context, check, ledgerView(context));
    if (afterLock) return { result: afterLock, snapshotStable: true };
    context.assertCurrent();
    const invocation = check.kind === "command"
      ? {
          command: context.env.REPO_HARNESS_BASH_BIN || "/bin/bash",
          args: ["--noprofile", "--norc", "-c", check.command] as readonly string[],
          cwd: resolveExecutionCwd(context.repoRoot, check.cwd),
        }
      : resolvePackageTest(context, check);
    const started = Date.now();
    const run = runProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: verificationChildEnv(context.env),
      inheritEnv: false,
      deadlineMs,
      maxOutputBytes: VERIFICATION_DIAGNOSTIC_MAX_BYTES,
      processGroup: true,
      ...(check.cost === "expensive"
        ? { expensiveRunLock: { cwd: context.repoRoot, gitBin: context.env.REPO_HARNESS_GIT_BIN || "git" } }
        : {}),
    });
    // Keep protocol ids below the ledger's generic high-entropy token length;
    // hashes carry cryptographic identity, while this id only correlates the
    // immutable run file and event.
    let snapshotStable = false;
    let snapshotDiagnostic: string | null = null;
    try {
      const afterRun = captureGitVirtualTreeSnapshot(context.repoRoot);
      snapshotStable = afterRun.snapshot_hash === context.snapshot.snapshot_hash;
      if (!snapshotStable) snapshotDiagnostic = "repository snapshot changed during execution";
    } catch {
      snapshotDiagnostic = "repository snapshot could not be captured after execution";
    }
    context.assertCurrent();
    const passed = run.ok && snapshotStable;
    const executionId = `vx-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const runFile = `.ai/harness/runs/verification-${executionId}.json`;
    const failureLogFile = passed ? null : `.ai/harness/runs/verification-${executionId}.log`;
    const message = passed
      ? "check passed"
      : run.timedOut
        ? `check timed out; diagnostics: ${failureLogFile}`
        : run.signal !== null
          ? `check terminated by ${run.signal}; diagnostics: ${failureLogFile}`
          : !run.ok
            ? `check exited ${run.status}; diagnostics: ${failureLogFile}`
            : `check exited successfully but ${snapshotDiagnostic}; diagnostics: ${failureLogFile}`;
    const result: VerificationExecutionResult = {
      id: check.id,
      kind: check.kind,
      target: "current_exact",
      passed,
      message,
      duration_ms: Date.now() - started,
      timed_out: run.timedOut,
      exit_code: run.signal === null ? run.status : null,
      signal: run.signal,
      execution: "executed",
      cache_key: key,
      command: run.command.join(" "),
      force_reason: input.forceReason?.trim() || null,
      execution_id: executionId,
      run_file: runFile,
      failure_log_file: failureLogFile,
    };
    if (failureLogFile) {
      const failureLogPath = resolveInsideRepo(context.repoRoot, failureLogFile);
      if (!failureLogPath.ok || !failureLogPath.path) throw new Error(failureLogPath.error ?? "invalid failure log path");
      const diagnostics = redactKnownEnvironmentValues(
        [message, run.stdout, run.stderr || run.error].filter(Boolean).join("\n"),
        context.env,
      );
      createFileExclusiveDurably(failureLogPath.path, Buffer.from(`${diagnostics}\n`, "utf8"));
    }
    const durableRecord = {
      protocol: 1,
      kind: "verification_execution_record",
      execution_id: executionId,
      cache_key: key,
      result,
    } as const;
    const runPath = resolveInsideRepo(context.repoRoot, runFile);
    if (!runPath.ok || !runPath.path) throw new Error(runPath.error ?? "invalid verification run path");
    const durableBytes = Buffer.from(`${JSON.stringify(durableRecord, null, 2)}\n`, "utf8");
    createFileExclusiveDurably(runPath.path, durableBytes);
    ensureGenesis(context);
    const genesis = readGenesisRecord(context.repoRoot)!;
    const payload: ExecutionPayload = {
      protocol: 2,
      ...context.binding,
      plan_hash: context.planHash,
      check_id: check.id,
      check_fingerprint: fingerprintVerificationCheck(check),
      execution_spec_hash: fingerprintVerificationCheckExecution(check),
      inputs_hash: declaredEnvironmentHash(check, context.env),
      toolchain_hash: context.toolchainHash,
      snapshot_hash: context.snapshot.snapshot_hash,
      cache_key: key,
      execution_id: executionId,
      run_file: runFile,
      run_record_hash: sha256Prefixed(durableBytes),
      passed: result.passed,
    };
    requestLock.assertOwned();
    if (result.passed) context.assertCurrent();
    appendEvidenceEvent(context.repoRoot, {
      worktreeId: genesis.worktree_id,
      eventType: EVENT_TYPE,
      trustClass: "authoritative_machine",
      producer: PRODUCER,
      correlationRunId: executionId,
      subjectIdentity: subjectIdentity(context, check),
      payload: { kind: "json", value: payload as unknown as JsonValue },
    });
    return { result, snapshotStable };
  } finally {
    requestLock.release();
  }
}

/** The existing report writer and direct readers consume the same ledger-safe projection. */
export function materializeVerificationExecutionReport(report: VerificationExecutionReport): VerificationExecutionReport {
  return redactPayloadStrings(report as unknown as JsonValue, collectDenylistSecretValues()) as unknown as VerificationExecutionReport;
}

export function writeVerificationExecutionReport(
  repoRoot: string,
  relativePath: string,
  report: VerificationOutcome,
): void {
  const outputPath = isAbsolute(relativePath) ? relativePath : resolve(repoRoot, relativePath);
  writeFileDurably(outputPath, `${JSON.stringify(materializeVerificationExecutionReport(report), null, 2)}\n`);
}

interface ExecutionOptions {
  readonly reportFile?: string;
  readonly forceReason?: string;
  readonly timeoutMs?: number;
}

/** Review callers cannot supply plans or alternate authority callbacks. */
export function executeAdmittedVerification(input: ExecuteAdmittedVerificationInput): VerificationOutcome {
  const report = executePrepared(input, () => prepare(input));
  if (report.kind !== "verification_execution_report") throw new Error("review authority required");
  return report;
}

/** Catalog grading has its own identity and cannot create review evidence. */
export function executeCatalogEval(input: {
  readonly repoRoot: string;
  readonly catalog: EvalCatalogSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly reportFile?: string;
}): EvalExecutionReport {
  const report = executePrepared(input, () => {
    const plan = readEvalCatalogPlan(input.repoRoot, input.catalog);
    const binding: EvalBinding = { authority_kind: "eval-catalog", catalog_sha256: input.catalog.catalog_sha256,
      eval_id: input.catalog.eval_id, eval_sha256: input.catalog.eval_sha256 };
    return prepareContext(input, { plan, binding, assertCurrent: () => {
      const current = readEvalCatalogPlan(input.repoRoot, input.catalog);
      if (hashVerificationPlan(current) !== hashVerificationPlan(plan)) throw new Error("eval catalog plan changed");
    } });
  });
  if (report.kind !== "eval_execution_report") throw new Error("eval catalog authority required");
  return report;
}

/** Shared command machinery; authority construction stays in the adapters. */
function executePrepared(input: ExecutionOptions, prepare: () => PreparedContext): ExecutionReport {
  if (input.forceReason !== undefined && input.forceReason.trim().length === 0) {
    throw new Error("forceReason must be non-empty when provided");
  }
  const budgetMs = input.timeoutMs ?? 3_600_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) throw new Error("timeoutMs must be a positive integer");
  const deadlineMs = Date.now() + budgetMs;
  const context = prepare();
  const results = new Map<string, VerificationExecutionResult>();
  let waiting = false;
  let needsPlan = false;
  let executionEligibilityFailed = false;
  let preflightFailed = false;
  let baselinePreflightsEvaluated = false;

  const evaluateBaselinePreflights = (): void => {
    if (baselinePreflightsEvaluated) return;
    baselinePreflightsEvaluated = true;
    const ledger = ledgerView(context);
    for (const check of context.plan.checks) {
      if (check.phase !== "preflight" || check.evidence_policy !== "baseline_with_delta") continue;
      const result = baselineResult(context, check, results, ledger);
      results.set(check.id, result);
      if (!result.passed) preflightFailed = true;
    }
  };

  const ordered = [...context.plan.checks].sort((left, right) =>
    (left.phase === right.phase ? 0 : left.phase === "preflight" ? -1 : 1));
  for (const check of ordered) {
    if (check.phase === "verification") evaluateBaselinePreflights();
    if (check.evidence_policy !== "current_exact") continue;
    if (preflightFailed) {
      results.set(check.id, missingResult(context, check, "not run because preflight failed"));
      continue;
    }
    // executeCheck appends to the ledger, so each check reads a new view.
    const ledger = ledgerView(context);
    const reused = input.forceReason ? null : reusableResult(context, check, ledger);
    if (reused) {
      results.set(check.id, reused);
      continue;
    }
    if (check.cost === "expensive" && priorExecutionExists(context, check, ledger) && !input.forceReason) {
      results.set(check.id, missingResult(context, check, "expensive input drift requires a new Verification Plan or an explicit force reason"));
      needsPlan = true;
      if (check.phase === "preflight") preflightFailed = true;
      continue;
    }
    const result = executeCheck(context, check, input, deadlineMs);
    if (result === "waiting") {
      results.set(check.id, missingResult(context, check, "an identical execution request is already running"));
      waiting = true;
      if (check.phase === "preflight") preflightFailed = true;
      continue;
    }
    results.set(check.id, result.result);
    if (!result.snapshotStable) executionEligibilityFailed = true;
    if (check.phase === "preflight" && !result.result.passed) preflightFailed = true;
  }
  evaluateBaselinePreflights();

  const finalLedger = ledgerView(context);
  const planOrder = context.plan.checks.map((check) => check.evidence_policy === "current_exact"
    ? results.get(check.id) ?? missingResult(context, check, "current exact execution is missing")
    : baselineResult(context, check, results, finalLedger));
  let snapshotChanged = false;
  try {
    snapshotChanged = captureGitVirtualTreeSnapshot(context.repoRoot).snapshot_hash !== context.snapshot.snapshot_hash;
  } catch {
    snapshotChanged = true;
  }
  let status: VerificationReportStatus;
  const processFailed = planOrder.some((result) => result.execution === "executed"
    && !result.passed
    && (result.exit_code !== 0 || result.timed_out || result.signal !== null));
  if (waiting) status = "waiting";
  else if (processFailed) status = "failed";
  else if (needsPlan || executionEligibilityFailed || snapshotChanged) status = "needs_verification_plan";
  else if (preflightFailed) status = "failed";
  else if (planOrder.every((result) => result.passed)) status = "passed";
  else status = "missing";
  const report = buildReport(context, planOrder, status, snapshotChanged);
  if (report.passed) context.assertCurrent();
  if (input.reportFile) {
    const outputPath = isAbsolute(input.reportFile) ? input.reportFile : resolve(context.repoRoot, input.reportFile);
    const materialized = redactPayloadStrings(report as unknown as JsonValue, collectDenylistSecretValues());
    writeFileDurably(outputPath, `${JSON.stringify(materialized, null, 2)}\n`);
  }
  return report;
}
