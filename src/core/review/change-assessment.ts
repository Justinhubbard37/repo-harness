import { byteCompare } from '../evidence/byte-compare';
import { canonicalize } from '../evidence/canonical-json';
import { SHA256_PREFIXED_PATTERN } from '../evidence/sha256-pattern';

import type { StrictRiskCategory, WorkflowProfile } from '../workflow/profile';

import {
  AUTHORITY_CATEGORIES,
  CHANGE_ASSESSMENT_PROTOCOL,
  IRREVERSIBLE_CATEGORIES,
  REVIEW_SELECTION_PACKET_PROTOCOL,
  STRICT_RISK_CATEGORIES,
  assessmentFingerprint,
  isStringArray,
  normalizeDeclaredReviewOracles,
  oracleCovers,
  orderReasons,
  packetFingerprint,
  parseReasons,
  reason,
  selectedPaths,
  subjectPaths,
  uniqueSorted,
  validSubject,
  type ChangeAssessment,
  type ChangeAssessmentInput,
  type ChangeAssessmentReason,
  type ChangeAssessmentResult,
  type DeclaredReviewOracle,
  type ReviewSelectionPacket,
  type ReviewerDisagreementInput,
} from './change-assessment-model';

export {
  CHANGE_ASSESSMENT_PROTOCOL,
  CHANGE_ASSESSMENT_REASON_CODES,
  REVIEW_ORACLE_KINDS,
  REVIEW_SELECTION_PACKET_PROTOCOL,
  normalizeDeclaredReviewOracles,
} from './change-assessment-model';
export type {
  AssessmentSubject,
  ChangeAssessment,
  ChangeAssessmentFailure,
  ChangeAssessmentInput,
  ChangeAssessmentReason,
  ChangeAssessmentReasonCode,
  ChangeAssessmentResult,
  DeclaredReviewOracle,
  ReviewOracleKind,
  ReviewSelectionPacket,
  ReviewerDisagreementInput,
} from './change-assessment-model';

/**
 * Pure final-subject assessment. It deliberately accepts already-observed
 * inputs only: no Hook event, wall clock, model output, or git command can
 * influence this result. That makes the packet stable across edit order and
 * allows verify-sprint to recompute it at the authoritative boundary.
 */
export function assessChange(input: ChangeAssessmentInput): ChangeAssessmentResult {
  if (!validSubject(input.subject)) {
    return Object.freeze({
      protocol: CHANGE_ASSESSMENT_PROTOCOL,
      kind: 'repo-harness-change-assessment-failure',
      status: 'degraded',
      code: 'subject_unavailable',
      message: input.subject.reason ?? 'final review subject is unavailable',
    });
  }
  const paths = subjectPaths(input.subject.paths);
  const oracles = normalizeDeclaredReviewOracles(input.declaredOracles);
  if (!paths || !oracles) {
    return Object.freeze({
      protocol: CHANGE_ASSESSMENT_PROTOCOL,
      kind: 'repo-harness-change-assessment-failure',
      status: 'degraded',
      code: 'invalid_input',
      message: 'assessment paths or declared oracles are invalid',
    });
  }

  const strictCategories = [...new Set(input.strictCategories)].sort(byteCompare);
  const patternNoveltyPaths = uniqueSorted(input.patternNoveltyPaths).filter((path) => paths.includes(path));
  const reasons: ChangeAssessmentReason[] = [];
  const authorityCategories = strictCategories.filter((category) => AUTHORITY_CATEGORIES.has(category));
  if (authorityCategories.length > 0) {
    reasons.push(reason(
      'authority_change',
      paths,
      ['deterministic_test'],
      `strict workflow categories: ${authorityCategories.join(', ')}`,
    ));
  }
  const irreversibleCategories = strictCategories.filter((category) => IRREVERSIBLE_CATEGORIES.has(category));
  if (irreversibleCategories.length > 0) {
    reasons.push(reason(
      'irreversible_effect',
      paths,
      ['runtime_readback'],
      `irreversible workflow categories: ${irreversibleCategories.join(', ')}`,
    ));
  }
  if (patternNoveltyPaths.length > 0) {
    reasons.push(reason(
      'pattern_novelty',
      patternNoveltyPaths,
      ['deterministic_test'],
      'final content contains a deterministic new-abstraction signal',
    ));
  }

  // An oracle is a path-level claim: a two-path risk cannot become ready
  // merely because its declaration covers one of the two paths. Derive the
  // gap per path so a later packet can show exactly which final-subject
  // surface is still without an executable oracle.
  const missingOraclePaths = uniqueSorted(reasons.flatMap((entry) => entry.paths.filter((path) => (
    entry.required_oracle_kinds.length > 0
      && !oracles.some((oracle) => oracleCovers(oracle, [path], entry.required_oracle_kinds))
  ))));
  if (missingOraclePaths.length > 0) {
    reasons.push(reason(
      'oracle_gap',
      missingOraclePaths,
      ['deterministic_test', 'runtime_readback'],
      'a selected risk surface has no declared executable oracle with the required kind',
    ));
  }

  const orderedReasons = orderReasons(reasons);
  const usedOracles = oracles.filter((oracle) => orderedReasons.some((entry) => oracleCovers(oracle, entry.paths, entry.required_oracle_kinds)));
  const basis: Omit<ChangeAssessment, 'assessment_sha256'> = {
    protocol: CHANGE_ASSESSMENT_PROTOCOL,
    kind: 'repo-harness-change-assessment',
    status: missingOraclePaths.length > 0 ? 'blocked' : 'ready',
    review_subject_sha256: input.subject.review_subject_sha256,
    target_ref: input.subject.target_ref,
    target_revision: input.subject.target_rev,
    subject_paths: paths,
    workflow_profile: input.workflowProfile,
    strict_categories: strictCategories,
    selected_paths: selectedPaths(orderedReasons),
    required_oracles: usedOracles,
    reasons: orderedReasons,
  };
  return Object.freeze({ ...basis, assessment_sha256: assessmentFingerprint(basis) });
}

export function buildReviewSelectionPacket(assessment: ChangeAssessment): ReviewSelectionPacket {
  const basis: Omit<ReviewSelectionPacket, 'packet_sha256'> = {
    protocol: REVIEW_SELECTION_PACKET_PROTOCOL,
    kind: 'repo-harness-review-selection-packet',
    status: assessment.status,
    assessment_sha256: assessment.assessment_sha256,
    review_subject_sha256: assessment.review_subject_sha256,
    target_ref: assessment.target_ref,
    target_revision: assessment.target_revision,
    subject_paths: assessment.subject_paths,
    selected_paths: assessment.selected_paths,
    required_oracles: assessment.required_oracles,
    reasons: assessment.reasons,
  };
  return Object.freeze({ ...basis, packet_sha256: packetFingerprint(basis) });
}

/**
 * Strictly validates the serialised base assessment before any subject-bound
 * caller compares it with a fresh recomputation. A fingerprint alone only
 * proves that a record hashes itself; this rejects malformed, non-canonical,
 * or reviewer-authored assessment shapes before that comparison.
 */
export function validateChangeAssessment(value: unknown): ChangeAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('change assessment must be an object');
  const assessment = value as Record<string, unknown>;
  const expectedKeys = [
    'assessment_sha256', 'kind', 'protocol', 'reasons', 'required_oracles',
    'review_subject_sha256', 'selected_paths', 'status', 'strict_categories', 'subject_paths',
    'target_ref', 'target_revision', 'workflow_profile',
  ];
  if (canonicalize(Object.keys(assessment).sort(byteCompare)) !== canonicalize(expectedKeys)) {
    throw new Error('change assessment contains unknown fields');
  }
  if (assessment.protocol !== CHANGE_ASSESSMENT_PROTOCOL || assessment.kind !== 'repo-harness-change-assessment') {
    throw new Error('change assessment kind/protocol is invalid');
  }
  if (assessment.status !== 'ready' && assessment.status !== 'blocked') throw new Error('change assessment status is invalid');
  for (const key of ['assessment_sha256', 'review_subject_sha256'] as const) {
    if (typeof assessment[key] !== 'string' || !SHA256_PREFIXED_PATTERN.test(assessment[key] as string)) {
      throw new Error(`change assessment ${key} is invalid`);
    }
  }
  if (typeof assessment.target_ref !== 'string' || assessment.target_ref.trim() === '') {
    throw new Error('change assessment target_ref is invalid');
  }
  if (typeof assessment.target_revision !== 'string' || !/^[0-9a-f]{40,64}$/.test(assessment.target_revision)) {
    throw new Error('change assessment target_revision is invalid');
  }
  if (!['routine', 'high'].includes(String(assessment.workflow_profile))) {
    throw new Error('change assessment workflow_profile is invalid');
  }
  if (!Array.isArray(assessment.subject_paths) || !Array.isArray(assessment.selected_paths) || !isStringArray(assessment.subject_paths) || !isStringArray(assessment.selected_paths)) {
    throw new Error('change assessment paths are invalid');
  }
  const paths = subjectPaths(assessment.subject_paths);
  if (!paths || canonicalize(paths) !== canonicalize(assessment.subject_paths)) throw new Error('change assessment subject paths are not canonical');
  const selected = uniqueSorted(assessment.selected_paths);
  if (canonicalize(selected) !== canonicalize(assessment.selected_paths) || selected.some((path) => !paths.includes(path))) {
    throw new Error('change assessment selected paths are invalid');
  }
  if (!Array.isArray(assessment.strict_categories) || !isStringArray(assessment.strict_categories)) {
    throw new Error('change assessment strict categories are invalid');
  }
  const categories = [...new Set(assessment.strict_categories as StrictRiskCategory[])].sort(byteCompare);
  if (categories.some((category) => !STRICT_RISK_CATEGORIES.has(category)) || canonicalize(categories) !== canonicalize(assessment.strict_categories)) {
    throw new Error('change assessment strict categories are not canonical');
  }
  if (!Array.isArray(assessment.required_oracles)) throw new Error('change assessment required oracles are invalid');
  const oracles = normalizeDeclaredReviewOracles(assessment.required_oracles);
  if (!oracles || canonicalize(oracles) !== canonicalize(assessment.required_oracles)) {
    throw new Error('change assessment required oracles are not canonical');
  }
  const reasons = parseReasons(assessment.reasons, paths, 'change assessment');
  if (reasons.some((entry) => entry.code === 'reviewer_disagreement')) {
    throw new Error('change assessment may not contain reviewer disagreement');
  }
  if (canonicalize(selectedPaths(reasons)) !== canonicalize(selected)) {
    throw new Error('change assessment selected paths do not match reasons');
  }
  const basis: Omit<ChangeAssessment, 'assessment_sha256'> = {
    protocol: CHANGE_ASSESSMENT_PROTOCOL,
    kind: 'repo-harness-change-assessment',
    status: assessment.status,
    review_subject_sha256: assessment.review_subject_sha256 as string,
    target_ref: assessment.target_ref,
    target_revision: assessment.target_revision as string,
    subject_paths: paths,
    workflow_profile: assessment.workflow_profile as WorkflowProfile,
    strict_categories: categories,
    selected_paths: selected,
    required_oracles: oracles,
    reasons,
  };
  if (assessmentFingerprint(basis) !== assessment.assessment_sha256) throw new Error('change assessment fingerprint is stale');
  return Object.freeze({ ...basis, assessment_sha256: assessment.assessment_sha256 as string });
}

/**
 * A reviewer disagreement is an append-only escalation. It can add one
 * closed-vocabulary reason and paths from the already-bound subject; it cannot
 * remove selection, alter the target, downgrade status, or replace oracles.
 */
export function applyReviewerDisagreement(
  packet: ReviewSelectionPacket,
  input: ReviewerDisagreementInput,
): ReviewSelectionPacket {
  if (packet.review_subject_sha256 !== input.review_subject_sha256 || packet.target_revision !== input.target_revision) {
    throw new Error('reviewer disagreement does not bind the selection packet subject');
  }
  if (input.summary.trim() === '') throw new Error('reviewer disagreement summary is required');
  const paths = uniqueSorted(input.paths);
  if (paths.length === 0 || paths.some((path) => !packet.subject_paths.includes(path))) {
    throw new Error('reviewer disagreement paths must be non-empty selected subject paths');
  }
  const existing = packet.reasons.find((entry) => entry.code === 'reviewer_disagreement');
  const disagreement = reason(
    'reviewer_disagreement',
    existing ? [...existing.paths, ...paths] : paths,
    [],
    input.summary.trim(),
  );
  const reasons = orderReasons([
    ...packet.reasons.filter((entry) => entry.code !== 'reviewer_disagreement'),
    disagreement,
  ]);
  const { packet_sha256: _packetSha256, ...boundPacket } = packet;
  const basis: Omit<ReviewSelectionPacket, 'packet_sha256'> = {
    ...boundPacket,
    selected_paths: uniqueSorted([...packet.selected_paths, ...paths]),
    reasons,
  };
  return Object.freeze({ ...basis, packet_sha256: packetFingerprint(basis) });
}

export function validateReviewSelectionPacket(value: unknown): ReviewSelectionPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review selection packet must be an object');
  const packet = value as Record<string, unknown>;
  if (packet.protocol !== REVIEW_SELECTION_PACKET_PROTOCOL || packet.kind !== 'repo-harness-review-selection-packet') {
    throw new Error('review selection packet kind/protocol is invalid');
  }
  if (packet.status !== 'ready' && packet.status !== 'blocked') throw new Error('review selection packet status is invalid');
  for (const key of ['assessment_sha256', 'review_subject_sha256', 'packet_sha256'] as const) {
    if (typeof packet[key] !== 'string' || !SHA256_PREFIXED_PATTERN.test(packet[key] as string)) {
      throw new Error(`review selection packet ${key} is invalid`);
    }
  }
  for (const key of ['target_ref', 'target_revision'] as const) {
    if (typeof packet[key] !== 'string' || (packet[key] as string).trim() === '') throw new Error(`review selection packet ${key} is invalid`);
  }
  if (!Array.isArray(packet.subject_paths) || !Array.isArray(packet.selected_paths) || !Array.isArray(packet.reasons) || !Array.isArray(packet.required_oracles)) {
    throw new Error('review selection packet arrays are invalid');
  }
  if (!isStringArray(packet.subject_paths) || !isStringArray(packet.selected_paths)) {
    throw new Error('review selection packet paths must be strings');
  }
  const normalizedSubjectPaths = subjectPaths(packet.subject_paths);
  if (!normalizedSubjectPaths) throw new Error('review selection packet subject paths are invalid');
  const selected = uniqueSorted(packet.selected_paths);
  if (selected.some((path) => !normalizedSubjectPaths.includes(path))) throw new Error('review selection packet selected paths escape subject');
  const oracles = normalizeDeclaredReviewOracles(packet.required_oracles as DeclaredReviewOracle[]);
  if (!oracles) throw new Error('review selection packet required oracles are invalid');
  const orderedReasons = parseReasons(packet.reasons, normalizedSubjectPaths, 'review selection packet');
  const basis: Omit<ReviewSelectionPacket, 'packet_sha256'> = {
    protocol: REVIEW_SELECTION_PACKET_PROTOCOL,
    kind: 'repo-harness-review-selection-packet',
    status: packet.status as 'ready' | 'blocked',
    assessment_sha256: packet.assessment_sha256 as string,
    review_subject_sha256: packet.review_subject_sha256 as string,
    target_ref: packet.target_ref as string,
    target_revision: packet.target_revision as string,
    subject_paths: normalizedSubjectPaths,
    selected_paths: selected,
    required_oracles: oracles,
    reasons: orderedReasons,
  };
  if (packetFingerprint(basis) !== packet.packet_sha256) throw new Error('review selection packet fingerprint is stale');
  return Object.freeze({ ...basis, packet_sha256: packet.packet_sha256 as string });
}

/**
 * Packets are projections of a freshly recomputed base assessment. The one
 * permitted post-assessment mutation is an append-only reviewer disagreement;
 * all other fields remain byte-for-byte bound to the base projection.
 */
export function validateReviewSelectionPacketAgainstAssessment(value: unknown, assessmentValue: unknown): ReviewSelectionPacket {
  const assessment = validateChangeAssessment(assessmentValue);
  const packet = validateReviewSelectionPacket(value);
  const base = buildReviewSelectionPacket(assessment);
  if (
    packet.status !== base.status
    || packet.assessment_sha256 !== base.assessment_sha256
    || packet.review_subject_sha256 !== base.review_subject_sha256
    || packet.target_ref !== base.target_ref
    || packet.target_revision !== base.target_revision
    || canonicalize(packet.subject_paths) !== canonicalize(base.subject_paths)
    || canonicalize(packet.required_oracles) !== canonicalize(base.required_oracles)
  ) {
    throw new Error('review selection packet does not bind the base assessment');
  }
  const baseReasons = base.reasons;
  const disagreement = packet.reasons.find((entry) => entry.code === 'reviewer_disagreement');
  const nonDisagreement = packet.reasons.filter((entry) => entry.code !== 'reviewer_disagreement');
  if (canonicalize(nonDisagreement) !== canonicalize(baseReasons)) {
    throw new Error('review selection packet alters base assessment reasons');
  }
  if (!disagreement) {
    if (canonicalize(packet.selected_paths) !== canonicalize(base.selected_paths) || canonicalize(packet.reasons) !== canonicalize(base.reasons)) {
      throw new Error('review selection packet alters the base assessment');
    }
    return packet;
  }
  if (disagreement.required_oracle_kinds.length !== 0 || disagreement.paths.length === 0 || disagreement.evidence.trim() === '') {
    throw new Error('reviewer disagreement overlay is invalid');
  }
  const expectedSelected = uniqueSorted([...base.selected_paths, ...disagreement.paths]);
  if (canonicalize(packet.selected_paths) !== canonicalize(expectedSelected)) {
    throw new Error('reviewer disagreement overlay is not monotonic');
  }
  return packet;
}
