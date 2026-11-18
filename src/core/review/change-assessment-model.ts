import { byteCompare } from '../evidence/byte-compare';
import { canonicalize } from '../evidence/canonical-json';
import { SHA256_PREFIXED_PATTERN } from '../evidence/sha256-pattern';
import { sha256Prefixed } from '../evidence/sha256';

import type { StrictRiskCategory, WorkflowProfile } from '../workflow/profile';

export const CHANGE_ASSESSMENT_PROTOCOL = 1 as const;
export const REVIEW_SELECTION_PACKET_PROTOCOL = 1 as const;

export const CHANGE_ASSESSMENT_REASON_CODES = [
  'authority_change',
  'irreversible_effect',
  'pattern_novelty',
  'reviewer_disagreement',
  'oracle_gap',
] as const;

export type ChangeAssessmentReasonCode = (typeof CHANGE_ASSESSMENT_REASON_CODES)[number];

export const REVIEW_ORACLE_KINDS = [
  'deterministic_test',
  'runtime_readback',
  'manual_acceptance',
] as const;

export type ReviewOracleKind = (typeof REVIEW_ORACLE_KINDS)[number];

export interface AssessmentSubject {
  readonly status: 'ok' | 'unknown';
  readonly target_ref: string;
  readonly target_rev: string;
  readonly head_rev: string;
  readonly paths: readonly string[];
  readonly review_subject_sha256: string;
  readonly reason?: string;
}

export interface DeclaredReviewOracle {
  readonly id: string;
  readonly kind: ReviewOracleKind;
  /** Literal reviewed paths, or `*` when the oracle applies to the whole subject. */
  readonly paths: readonly string[];
}

export interface ChangeAssessmentReason {
  readonly code: ChangeAssessmentReasonCode;
  readonly paths: readonly string[];
  readonly required_oracle_kinds: readonly ReviewOracleKind[];
  readonly evidence: string;
}

export interface ChangeAssessment {
  readonly protocol: typeof CHANGE_ASSESSMENT_PROTOCOL;
  readonly kind: 'repo-harness-change-assessment';
  readonly status: 'ready' | 'blocked';
  readonly review_subject_sha256: string;
  readonly target_ref: string;
  readonly target_revision: string;
  readonly subject_paths: readonly string[];
  readonly workflow_profile: WorkflowProfile;
  readonly strict_categories: readonly StrictRiskCategory[];
  readonly selected_paths: readonly string[];
  readonly required_oracles: readonly DeclaredReviewOracle[];
  readonly reasons: readonly ChangeAssessmentReason[];
  readonly assessment_sha256: string;
}

export interface ChangeAssessmentFailure {
  readonly protocol: typeof CHANGE_ASSESSMENT_PROTOCOL;
  readonly kind: 'repo-harness-change-assessment-failure';
  readonly status: 'degraded';
  readonly code: 'subject_unavailable' | 'invalid_input';
  readonly message: string;
}

export type ChangeAssessmentResult = ChangeAssessment | ChangeAssessmentFailure;

export interface ReviewSelectionPacket {
  readonly protocol: typeof REVIEW_SELECTION_PACKET_PROTOCOL;
  readonly kind: 'repo-harness-review-selection-packet';
  readonly status: 'ready' | 'blocked';
  readonly assessment_sha256: string;
  readonly review_subject_sha256: string;
  readonly target_ref: string;
  readonly target_revision: string;
  readonly subject_paths: readonly string[];
  readonly selected_paths: readonly string[];
  readonly required_oracles: readonly DeclaredReviewOracle[];
  readonly reasons: readonly ChangeAssessmentReason[];
  readonly packet_sha256: string;
}

export interface ReviewerDisagreementInput {
  readonly review_subject_sha256: string;
  readonly target_revision: string;
  readonly paths: readonly string[];
  readonly summary: string;
}

export interface ChangeAssessmentInput {
  readonly subject: AssessmentSubject;
  readonly workflowProfile: WorkflowProfile;
  readonly strictCategories: readonly StrictRiskCategory[];
  readonly patternNoveltyPaths: readonly string[];
  readonly declaredOracles: readonly DeclaredReviewOracle[];
}

export const AUTHORITY_CATEGORIES = new Set<StrictRiskCategory>([
  'auth', 'payment', 'security', 'schema', 'public-api',
]);
export const IRREVERSIBLE_CATEGORIES = new Set<StrictRiskCategory>([
  'migration', 'deploy', 'release', 'destructive',
]);
export const STRICT_RISK_CATEGORIES = new Set<StrictRiskCategory>([
  'auth', 'payment', 'security', 'schema', 'migration', 'deploy', 'release', 'public-api', 'destructive',
]);

function sha256(value: unknown): string {
  return sha256Prefixed(canonicalize(value));
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(byteCompare);
}

export function isStringArray(value: readonly unknown[]): value is readonly string[] {
  return value.every((entry) => typeof entry === 'string');
}

export function validSubject(subject: AssessmentSubject): boolean {
  return subject.status === 'ok'
    && SHA256_PREFIXED_PATTERN.test(subject.review_subject_sha256)
    && subject.target_ref.trim() !== ''
    && /^[0-9a-f]{40,64}$/.test(subject.target_rev)
    && /^[0-9a-f]{40,64}$/.test(subject.head_rev);
}

function normalizeOracle(oracle: unknown): DeclaredReviewOracle | null {
  if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) return null;
  const record = oracle as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(record.id)) return null;
  if (!REVIEW_ORACLE_KINDS.includes(record.kind as ReviewOracleKind)) return null;
  if (!Array.isArray(record.paths) || !isStringArray(record.paths)) return null;
  const paths = uniqueSorted(record.paths);
  if (paths.length === 0 || paths.some((path) => path !== '*' && (path.startsWith('/') || path.includes('..') || path.includes('\\')))) {
    return null;
  }
  return Object.freeze({ id: record.id, kind: record.kind as ReviewOracleKind, paths });
}

export function normalizeDeclaredReviewOracles(oracles: readonly unknown[]): DeclaredReviewOracle[] | null {
  const values: DeclaredReviewOracle[] = [];
  const ids = new Set<string>();
  for (const oracle of oracles) {
    const normalized = normalizeOracle(oracle);
    if (!normalized || ids.has(normalized.id)) return null;
    ids.add(normalized.id);
    values.push(normalized);
  }
  return values.sort((left, right) => byteCompare(left.id, right.id));
}

export function subjectPaths(paths: readonly string[]): string[] | null {
  const normalized = uniqueSorted(paths);
  if (normalized.some((path) => path.startsWith('/') || path.includes('..') || path.includes('\\') || path === '*')) return null;
  return normalized;
}

export function reason(
  code: ChangeAssessmentReasonCode,
  paths: readonly string[],
  requiredOracleKinds: readonly ReviewOracleKind[],
  evidence: string,
): ChangeAssessmentReason {
  return Object.freeze({
    code,
    paths: uniqueSorted(paths),
    required_oracle_kinds: [...new Set(requiredOracleKinds)],
    evidence,
  });
}

export function oracleCovers(oracle: DeclaredReviewOracle, paths: readonly string[], kinds: readonly ReviewOracleKind[]): boolean {
  if (!kinds.includes(oracle.kind)) return false;
  return oracle.paths.includes('*') || paths.every((path) => oracle.paths.includes(path));
}

function canonicalAssessment(value: Omit<ChangeAssessment, 'assessment_sha256'>): Omit<ChangeAssessment, 'assessment_sha256'> {
  return value;
}

export function assessmentFingerprint(value: Omit<ChangeAssessment, 'assessment_sha256'>): string {
  return sha256(canonicalAssessment(value));
}

function canonicalPacket(value: Omit<ReviewSelectionPacket, 'packet_sha256'>): Omit<ReviewSelectionPacket, 'packet_sha256'> {
  return value;
}

export function packetFingerprint(value: Omit<ReviewSelectionPacket, 'packet_sha256'>): string {
  return sha256(canonicalPacket(value));
}

export function selectedPaths(reasons: readonly ChangeAssessmentReason[]): string[] {
  return uniqueSorted(reasons.flatMap((entry) => entry.paths));
}

export function orderReasons(reasons: readonly ChangeAssessmentReason[]): ChangeAssessmentReason[] {
  const byCode = new Map(reasons.map((entry) => [entry.code, entry]));
  return CHANGE_ASSESSMENT_REASON_CODES.flatMap((code) => {
    const entry = byCode.get(code);
    return entry ? [entry] : [];
  });
}

export function parseReasons(value: unknown, subject: readonly string[], label: string): ChangeAssessmentReason[] {
  if (!Array.isArray(value)) throw new Error(`${label} reasons are invalid`);
  const reasons = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} reason is invalid`);
    const record = entry as Record<string, unknown>;
    if (!CHANGE_ASSESSMENT_REASON_CODES.includes(record.code as ChangeAssessmentReasonCode)) {
      throw new Error(`${label} reason code is invalid`);
    }
    if (!Array.isArray(record.paths) || !Array.isArray(record.required_oracle_kinds) || typeof record.evidence !== 'string') {
      throw new Error(`${label} reason fields are invalid`);
    }
    if (!isStringArray(record.paths)) throw new Error(`${label} reason paths must be strings`);
    const paths = uniqueSorted(record.paths);
    if (paths.length === 0 || paths.some((path) => !subject.includes(path))) {
      throw new Error(`${label} reason path escapes subject`);
    }
    const kinds = record.required_oracle_kinds as ReviewOracleKind[];
    if (kinds.some((kind) => !REVIEW_ORACLE_KINDS.includes(kind))) {
      throw new Error(`${label} reason oracle kind is invalid`);
    }
    if (record.evidence.trim() === '') throw new Error(`${label} reason evidence is required`);
    return reason(record.code as ChangeAssessmentReasonCode, paths, kinds, record.evidence);
  });
  const ordered = orderReasons(reasons);
  if (canonicalize(ordered) !== canonicalize(reasons)) throw new Error(`${label} reasons are not closed-order canonical`);
  return ordered;
}
