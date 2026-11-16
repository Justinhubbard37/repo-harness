/**
 * The one rule that decides which finding severities block a merge (#2936).
 *
 * A review returns `FAIL` only for a P0 or a P1 finding. A P2 is a real
 * defect that is small, so it becomes a follow-up issue; a P3 is a note. The
 * review publish receipt, the generic review result and the acceptance
 * receipt each derive a verdict or a blocking count from a severity through
 * this module, so the rule has one authority.
 *
 * The rating of a finding stays a reviewer duty: a defect that touches I1 (a
 * credential leak by rh code) or I2 (a deletion or overwrite of a user file
 * without authorization) is rated at least P1. No code reads a severity to
 * move a finding between those tiers.
 */
export type ReviewSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** The severities that a reviewer may not merge with. Sorted by severity. */
export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = Object.freeze(['P0', 'P1']);

/** True for a severity that blocks a merge: P0 or P1. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return BLOCKING_SEVERITIES.includes(severity);
}
