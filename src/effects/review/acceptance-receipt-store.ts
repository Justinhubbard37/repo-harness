import { retryWindowsSharingRace } from '../atomic-append';
import { gatesDirectoryName } from '../git/repository-identity';
import { observationReadFileSync as readFileSync } from '../readonly-observation';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, isAbsolute, join } from 'path';
import {
  ACCEPTANCE_VERIFICATION_OBSERVATION_KIND,
  ACCEPTANCE_VERIFICATION_OBSERVATION_PROTOCOL,
  acceptanceVerificationObservationSubjectKey,
  assertReviewFields,
  assertUserWaiverGrant,
  buildAcceptanceVerificationObservation,
  fail,
  stableJson,
  validateFindings,
  type AcceptanceReceipt,
  type AcceptanceReviewResult,
  type AcceptanceVerificationObservationV1,
  type UserWaiverGrant,
} from '../../core/review/acceptance-receipt';
import { isRecord } from '../../core/evidence/is-record';
import { SHA256_PREFIXED_PATTERN } from '../../core/evidence/sha256-pattern';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { validateRequiredCheckFailureEvidenceList } from '../../core/evidence/required-check-evidence';
import { validateRequiredCheckCoverageEvidenceOrNull } from '../../core/publication/required-check-coverage';

export function reviewResultPath(root: string, authorityHome: string): string {
  return acceptanceReceiptPath(root, authorityHome).replace('acceptance.latest.json', 'acceptance.review-result.json');
}


function stateRoot(authorityHome: string): string {
  const home = realpathSync(authorityHome);
  if (!isAbsolute(home)) fail('authority home must be absolute');
  return join(home, '.repo-harness');
}

export function acceptanceReceiptPath(root: string, authorityHome: string, createParent = false): string {
  const parent = join(stateRoot(authorityHome), 'gates', gatesDirectoryName(realpathSync(root)));
  if (createParent) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  return join(parent, 'acceptance.latest.json');
}




/**
 * `acceptance.latest.json` is replaced by every later review in this checkout.
 * Each recorded receipt is also kept write-once under its own digest, so an
 * observation or product projection that pinned the digest still reads the
 * exact receipt it was built from.
 */
export function acceptanceReceiptRecordPath(root: string, authorityHome: string, receiptSha256: string, createParent = false): string {
  if (!SHA256_PREFIXED_PATTERN.test(receiptSha256)) fail('AcceptanceReceipt record digest is invalid');
  const parent = join(stateRoot(authorityHome), 'gates', gatesDirectoryName(realpathSync(root)), 'acceptance-receipts');
  if (createParent) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  return join(parent, `${receiptSha256.slice('sha256:'.length)}.json`);
}

function persistAcceptanceReceiptRecord(root: string, authorityHome: string, bytes: Buffer): string {
  const digest = sha256Prefixed(bytes);
  const path = acceptanceReceiptRecordPath(root, authorityHome, digest, true);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!readFileSync(path).equals(bytes)) fail('AcceptanceReceipt record conflicts with existing bytes');
  } finally {
    unlinkSync(temporary);
  }
  return digest;
}

export function readAcceptanceReceiptRecord(
  root: string,
  authorityHome: string,
  receiptSha256: string,
): { readonly bytes: Buffer; readonly receipt: AcceptanceReceipt } {
  const path = acceptanceReceiptRecordPath(root, authorityHome, receiptSha256);
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      fail('AcceptanceReceipt record must be a regular file of at most 1 MiB');
    }
    bytes = readFileSync(path);
  } catch (error) {
    fail(`AcceptanceReceipt record is unavailable for ${receiptSha256}: ${(error as Error).message}`);
  }
  if (sha256Prefixed(bytes) !== receiptSha256) fail('AcceptanceReceipt record does not match its digest');
  return Object.freeze({ bytes, receipt: parseReceipt(bytes.toString('utf-8')) });
}

export function userWaiverGrantPath(root: string, authorityHome: string, createParent = false): string {
  const parent = join(stateRoot(authorityHome), 'gates', gatesDirectoryName(realpathSync(root)));
  if (createParent) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  return join(parent, 'user-waiver-grant.latest.json');
}


export function acceptanceVerificationObservationPath(
  root: string,
  authorityHome: string,
  campaignSha256: string,
  admissionSha256: string,
  createParent = false,
): string {
  const parent = join(stateRoot(authorityHome), 'gates', gatesDirectoryName(realpathSync(root)), 'acceptance-observations');
  if (createParent) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  const key = acceptanceVerificationObservationSubjectKey(campaignSha256, admissionSha256);
  return join(parent, `${key.slice('sha256:'.length)}.json`);
}



export function writeAcceptanceVerificationObservation(args: {
  root: string;
  authorityHome: string;
  receipt: AcceptanceReceipt;
}): AcceptanceVerificationObservationV1 {
  const root = realpathSync(args.root);
  const observation = buildAcceptanceVerificationObservation({
    repository_root: root,
    acceptance_receipt_sha256: persistAcceptanceReceiptRecord(root, args.authorityHome, serializedRecord(args.receipt)),
    campaign_sha256: args.receipt.campaign_sha256,
    admission_sha256: args.receipt.admission_sha256,
    grant_sha256: args.receipt.grant_sha256,
    goal_sha256: args.receipt.goal_sha256,
    target_ref: args.receipt.target_ref,
    target_revision: args.receipt.target_revision,
    subject_sha256: args.receipt.subject_sha256,
    verification_evidence_sha256: args.receipt.verification_evidence_sha256,
    disposition: args.receipt.disposition,
    archive_projection_sha256: null,
    verified_at: args.receipt.issued_at,
  });
  const path = acceptanceVerificationObservationPath(
    root,
    args.authorityHome,
    observation.campaign_sha256,
    observation.admission_sha256,
    true,
  );
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${stableJson(observation)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  retryWindowsSharingRace(() => renameSync(temporary, path));
  return observation;
}

export function readAcceptanceVerificationObservation(
  root: string,
  authorityHome: string,
  campaignSha256: string,
  admissionSha256: string,
): AcceptanceVerificationObservationV1 | null {
  const repositoryRoot = realpathSync(root);
  const path = acceptanceVerificationObservationPath(repositoryRoot, authorityHome, campaignSha256, admissionSha256);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`AcceptanceVerificationObservation is invalid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(value)
    || value.protocol !== ACCEPTANCE_VERIFICATION_OBSERVATION_PROTOCOL
    || value.kind !== ACCEPTANCE_VERIFICATION_OBSERVATION_KIND) {
    fail('AcceptanceVerificationObservation kind/protocol is invalid');
  }
  const record = value as unknown as AcceptanceVerificationObservationV1;
  if (record.repository_root !== repositoryRoot) fail('AcceptanceVerificationObservation repository root is stale');
  if (record.campaign_sha256 !== campaignSha256 || record.admission_sha256 !== admissionSha256) {
    fail('AcceptanceVerificationObservation subject is stale');
  }
  if (!SHA256_PREFIXED_PATTERN.test(record.grant_sha256)) fail('AcceptanceVerificationObservation grant_sha256 is invalid');
  if (!['external_pass', 'user_waiver', 'reject'].includes(String(record.disposition))) {
    fail('AcceptanceVerificationObservation disposition is invalid');
  }
  const rebuilt = buildAcceptanceVerificationObservation({
    repository_root: record.repository_root,
    acceptance_receipt_sha256: record.acceptance_receipt_sha256,
    campaign_sha256: record.campaign_sha256,
    admission_sha256: record.admission_sha256,
    grant_sha256: record.grant_sha256,
    goal_sha256: record.goal_sha256,
    target_ref: record.target_ref,
    target_revision: record.target_revision,
    subject_sha256: record.subject_sha256,
    verification_evidence_sha256: record.verification_evidence_sha256,
    disposition: record.disposition,
    archive_projection_sha256: record.archive_projection_sha256,
    verified_at: record.verified_at,
  });
  if (record.observation_id !== rebuilt.observation_id) fail('AcceptanceVerificationObservation id is stale');
  if (`${stableJson(rebuilt)}\n` !== raw) fail('AcceptanceVerificationObservation bytes are not canonical');
  const key = acceptanceVerificationObservationSubjectKey(rebuilt.campaign_sha256, rebuilt.admission_sha256);
  if (basename(path) !== `${key.slice('sha256:'.length)}.json`) {
    fail('AcceptanceVerificationObservation is misfiled');
  }
  return rebuilt;
}



export function readReceipt(path: string): AcceptanceReceipt {
  if (!existsSync(path)) fail(`AcceptanceReceipt is missing: ${path}`);
  return parseReceipt(readFileSync(path, 'utf-8'));
}

function parseReceipt(text: string): AcceptanceReceipt {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`AcceptanceReceipt is invalid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(value) || value.protocol !== 4 || value.kind !== 'repo-harness-acceptance-receipt') {
    fail('AcceptanceReceipt kind/protocol is invalid');
  }
  const requiredStrings = [
    'repository_root', 'campaign_sha256', 'admission_sha256', 'grant_sha256', 'goal_sha256',
    'verification_file', 'verification_evidence_sha256', 'benchmark_evidence_sha256',
    'subject_sha256', 'subject_scope', 'target_ref', 'target_revision', 'disposition',
    'expected_reviewer', 'reviewer', 'source', 'summary', 'issued_at',
  ];
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || String(value[field]).trim() === '') fail(`AcceptanceReceipt ${field} is required`);
  }
  if (!['external_pass', 'user_waiver', 'reject'].includes(String(value.disposition))) fail('AcceptanceReceipt disposition is invalid');
  if (!['Claude', 'Codex'].includes(String(value.expected_reviewer))) fail('AcceptanceReceipt expected_reviewer is invalid');
  if (!['Claude', 'Codex', 'Pi', 'User'].includes(String(value.reviewer))) fail('AcceptanceReceipt reviewer is invalid');
  if (!['generic-review', 'user-waiver'].includes(String(value.source))) fail('AcceptanceReceipt source is invalid');
  if (value.actor !== null && (typeof value.actor !== 'string' || value.actor.trim() === '')) fail('AcceptanceReceipt actor is invalid');
  if (value.waiver_grant_sha256 !== null && !SHA256_PREFIXED_PATTERN.test(String(value.waiver_grant_sha256))) {
    fail('AcceptanceReceipt waiver_grant_sha256 is invalid');
  }
  for (const field of ['campaign_sha256', 'admission_sha256', 'grant_sha256', 'goal_sha256', 'verification_evidence_sha256', 'subject_sha256']) {
    if (!SHA256_PREFIXED_PATTERN.test(String(value[field]))) fail(`AcceptanceReceipt ${field} is invalid`);
  }
  if (!Array.isArray(value.reviewed_paths) || value.reviewed_paths.some((entry) => typeof entry !== 'string')) {
    fail('AcceptanceReceipt reviewed_paths must be strings');
  }
  if ((value.disposition === 'user_waiver') !== (value.waiver_grant_sha256 !== null)) {
    fail('AcceptanceReceipt waiver grant binding does not match disposition');
  }
  const receipt = { ...value, findings: validateFindings(value.findings),
    failures: validateRequiredCheckFailureEvidenceList(value.failures),
    required_check_coverage: validateRequiredCheckCoverageEvidenceOrNull(value.required_check_coverage) } as AcceptanceReceipt;
  assertReviewFields(receipt);
  return receipt;
}

/**
 * The one serialization of a receipt file. The digest-keyed record stores
 * these bytes for the receipt being recorded, never a re-read of the latest
 * file another acceptance in the same checkout may have replaced.
 */
function serializedRecord(receipt: AcceptanceReceipt | AcceptanceReviewResult): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
}

export function writeReceipt(path: string, receipt: AcceptanceReceipt | AcceptanceReviewResult): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, serializedRecord(receipt), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  retryWindowsSharingRace(() => renameSync(temporary, path));
}

export function readUserWaiverGrantFile(path: string): UserWaiverGrant {
  return readUserWaiverGrant(path);
}

export function readUserWaiverGrant(path: string): UserWaiverGrant {
  if (!existsSync(path)) fail(`UserWaiverGrant is missing: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    fail(`UserWaiverGrant is invalid JSON: ${(error as Error).message}`);
  }
  assertUserWaiverGrant(value);
  return value;
}

export function writeUserWaiverGrant(path: string, grant: UserWaiverGrant): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  retryWindowsSharingRace(() => renameSync(temporary, path));
}





export function writeAcceptanceWithObservation(
  root: string,
  authorityHome: string,
  receipt: AcceptanceReceipt,
): void {
  const acceptancePath = acceptanceReceiptPath(root, authorityHome, true);
  const observationPath = acceptanceVerificationObservationPath(
    root,
    authorityHome,
    receipt.campaign_sha256,
    receipt.admission_sha256,
    true,
  );
  const previousObservation = existsSync(observationPath) ? readFileSync(observationPath) : null;
  const restoreObservation = (): void => {
    if (previousObservation === null) {
      if (existsSync(observationPath)) unlinkSync(observationPath);
      return;
    }
    writeFileSync(observationPath, previousObservation, { mode: 0o600 });
    chmodSync(observationPath, 0o600);
  };
  const previousAcceptance = existsSync(acceptancePath) ? readFileSync(acceptancePath) : null;
  try {
    writeReceipt(acceptancePath, receipt);
    // The observation is part of the same acceptance transaction: an
    // acceptance that cannot publish its verified observation is rolled back
    // rather than left readable without one.
    writeAcceptanceVerificationObservation({ root, authorityHome, receipt });
  } catch (error) {
    if (previousAcceptance === null) {
      if (existsSync(acceptancePath)) unlinkSync(acceptancePath);
    } else {
      writeFileSync(acceptancePath, previousAcceptance, { mode: 0o600 });
      chmodSync(acceptancePath, 0o600);
    }
    restoreObservation();
    throw error;
  }

}
