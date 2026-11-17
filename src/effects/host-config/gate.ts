import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import {
  HostConfigError,
  expectedFromCommitted,
  sameExpected,
  type ExpectedFile,
  type FileCommitted,
  type FileRecord,
  type FileRecordKind,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigLedger,
  type HostPath,
  type Sha256,
  type SkippedOverride,
} from '../../core/host-config/types';
import {
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  missingDirectories,
  observeFile,
  putVault,
  readLedger,
  readVault,
  removeCreatedDirectories,
  removeTarget,
  replaceTarget,
  resolveHostPath,
  writeLedger,
  type HostConfigPaths,
} from './store';
import { isPathInside } from '../path-containment';

export interface HostConfigFileChange {
  readonly path: string;
  readonly fragments: readonly FragmentRequest[];
  /** An earlier rh version wrote this path before the ledger existed. */
  readonly baselineUnknown?: boolean;
}

export interface HostConfigApplyResult {
  readonly written: readonly string[];
  readonly skipped: readonly SkippedOverride[];
}

export interface HostConfigDelegateResult {
  readonly changed: readonly string[];
}

export interface HostConfigRevertEntry {
  readonly path: string;
  /**
   * `released`: the file already equals its backup (rh's fragments were its
   * text), so only the records go. `kept_edited`: the file is not as rh recorded it, so the file
   * and its record stay.
   */
  readonly action: 'removed' | 'restored' | 'text_removed' | 'released' | 'kept_edited';
}

/** A fragment that an earlier rh version wrote, as its old record names it. */
export interface AdoptedFragment {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  readonly inserted: string;
}

/**
 * One-shot migration of a file that an earlier rh version wrote before the
 * ledger existed. `backup` is the file before rh, rebuilt from the old record;
 * null when rh created the file.
 */
export interface HostConfigAdoption {
  readonly backup: Buffer | null;
  readonly fragments: readonly AdoptedFragment[];
  readonly externalChange: boolean;
}

export interface HostConfigRevertOptions {
  /** Report what the revert would do and write nothing. */
  readonly dryRun?: boolean;
}

export interface HostConfigGateOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export interface HostConfigGate {
  apply(changes: readonly HostConfigFileChange[]): HostConfigApplyResult;
  /**
   * Only for out-of-process writers: `run` gets the destinations with links
   * followed and may write them. The gate backs up the bytes that rh did not
   * write and records each path before `run`, and records each change after.
   */
  delegate(declaredPaths: readonly string[], run: (destinations: readonly string[]) => void): HostConfigDelegateResult;
  /** Undo rh's recorded writes, for the named paths or for all; a path without a record is not touched. */
  revert(paths?: readonly string[], options?: HostConfigRevertOptions): readonly HostConfigRevertEntry[];
  /**
   * Record a file that has no record, with `baseline.state: unknown` and
   * `committed` set to the current file. It writes no host file. A path that
   * already has a record keeps it (`recorded`), so a migration can run again.
   */
  adopt(path: string, adoption: HostConfigAdoption): 'adopted' | 'recorded';
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(bytes: Buffer | null, path: string): string {
  try { return bytes === null ? '' : UTF8.decode(bytes); }
  catch { throw new HostConfigError('host_config_invalid_state', `not UTF-8 text: ${path}`); }
}

/** Two aliases of one file are one path. */
function admitPaths(paths: HostConfigPaths, targets: readonly string[]): HostPath[] {
  const admitted = targets.map((path) => resolveHostPath(paths, path));
  if (new Set(admitted).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  ensurePrivateDirectory(paths.vault);
  return admitted;
}

function committedOf(expected: ExpectedFile): FileCommitted {
  return expected.existed ? { type: 'file', sha256: expected.sha256 } : { type: 'absent' };
}

function isCommitted(record: FileRecord, observed: ExpectedFile): boolean {
  return sameExpected(observed, expectedFromCommitted(record.committed));
}

/**
 * The first record of a path fixes its kind and baseline. Later writes update
 * `committed`, set a new backup when they replace bytes that rh did not write,
 * and keep `external_change` once the file differed from `committed`.
 */
function nextFileRecord(previous: FileRecord | undefined, first: { kind: FileRecordKind; backup: Sha256 | null; baselineUnknown: boolean },
  preimage: ExpectedFile, written: ExpectedFile): FileRecord {
  if (!previous) {
    return {
      kind: first.kind,
      baseline: first.baselineUnknown ? { state: 'unknown' }
        : preimage.existed ? { state: 'known', existed: true, sha256: preimage.sha256 } : { state: 'known', existed: false },
      committed: committedOf(written),
      backup: first.backup,
      external_change: false,
    };
  }
  return {
    ...previous,
    committed: committedOf(written),
    backup: first.backup ?? previous.backup,
    external_change: previous.external_change || !isCommitted(previous, preimage),
  };
}

/** An outside edit since rh's last write is recorded also when rh writes nothing now. */
function markExternalChange(files: Record<string, FileRecord>, path: string, preimage: ExpectedFile): boolean {
  const recorded = files[path];
  if (!recorded || recorded.external_change || isCommitted(recorded, preimage)) return false;
  files[path] = { ...recorded, external_change: true };
  return true;
}

/** True when the ledger does not already hold this fragment with this text. */
function fragmentChanges(fragment: PlannedFragment): boolean {
  return !fragment.previous || fragment.previous.inserted !== fragment.edit.inserted;
}

/** The whole file goes to the vault before rh writes over bytes that rh did not write. */
function backupUserBytes(paths: HostConfigPaths, previous: FileRecord | undefined, preimage: ExpectedFile, bytes: Buffer | null): Sha256 | null {
  return bytes !== null && (!previous || !isCommitted(previous, preimage)) ? putVault(paths, bytes) : null;
}

/** The fragment records of one file after its plan: a planned fragment replaces the record of its owner and selector. */
function fileFragments(plan: FilePlan, recorded: readonly FragmentRecord[]): FragmentRecord[] {
  const replaced = new Set(plan.fragments.map((fragment) => fragment.previous));
  return [
    ...recorded.filter((entry) => !replaced.has(entry)),
    ...plan.fragments.map(({ owner, selector, kind, edit }) => ({ file: plan.file, owner, selector, kind, inserted: edit.inserted })),
  ];
}

/** Each record reaches the ledger before its write, so every write has its record. */
function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[]): HostConfigApplyResult {
  const targets = admitPaths(paths, changes.map((change) => change.path));
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let { fragments, directories } = ledger;
  const persist = () => writeLedger(paths, { protocol: 1, files, fragments, directories });
  const skipped: SkippedOverride[] = [];
  const written: HostPath[] = [];
  for (const [index, change] of changes.entries()) {
    const path = targets[index]!;
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    const content = decode(bytes, path);
    const recorded = fragments.filter((entry) => entry.file === path);
    const plan = planFile(path, content, change.fragments, recorded);
    skipped.push(...plan.skipped);
    const unchanged = plan.result === content;
    // A fragment whose text is already in place is still recorded, but its file is not written.
    if (unchanged && !plan.fragments.some(fragmentChanges)) {
      if (markExternalChange(files, path, preimage)) persist();
      continue;
    }
    const previous = files[path];
    const before = { fragments, directories };
    const result = Buffer.from(plan.result, 'utf8');
    const createdDirs = unchanged ? [] : missingDirectories(path);
    const backup = backupUserBytes(paths, previous, preimage, bytes);
    fragments = [...fragments.filter((entry) => entry.file !== path), ...fileFragments(plan, recorded)];
    directories = [...directories, ...createdDirs];
    files[path] = nextFileRecord(previous, { kind: preimage.existed ? 'text_block' : 'created', backup, baselineUnknown: change.baselineUnknown === true },
      preimage, unchanged ? preimage : { existed: true, sha256: sha256Prefixed(result) });
    persist();
    if (unchanged) continue;
    try {
      createDirectories(createdDirs);
      replaceTarget(path, result, preimage);
    } catch (error) {
      removeCreatedDirectories(createdDirs);
      ({ fragments, directories } = before);
      if (previous) files[path] = previous; else delete files[path];
      persist();
      throw error;
    }
    written.push(path);
  }
  return { written, skipped };
}

function delegateWrite(paths: HostConfigPaths, declaredPaths: readonly string[], run: (destinations: readonly HostPath[]) => void): HostConfigDelegateResult {
  const targets = admitPaths(paths, declaredPaths);
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  const persist = () => writeLedger(paths, { ...ledger, files });
  const observed = targets.map((path) => {
    const previous = files[path];
    // A whole-file writer would replace rh's text blocks and the user's bytes around them with no record of either.
    if (previous?.kind === 'text_block') throw new HostConfigError('host_config_invalid_state', `rh text blocks are recorded in this file, so a delegated writer may not replace it: ${path}`);
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    const backup = backupUserBytes(paths, previous, preimage, bytes);
    const provisional = nextFileRecord(previous, { kind: preimage.existed ? 'replaced' : 'created', backup, baselineUnknown: false }, preimage, preimage);
    return { path, preimage, previous, provisional };
  });
  for (const { path, provisional } of observed) files[path] = provisional;
  persist();
  let failure: unknown = null;
  try { run(targets); } catch (error) { failure = error; }

  // Every change the writer made keeps its record, also when the writer failed; an unchanged path gets its old record back.
  const changed: HostPath[] = [];
  for (const { path, preimage, previous, provisional } of observed) {
    const result = expectedOf(observeFile(path).observation, path);
    if (!sameExpected(result, preimage)) {
      files[path] = { ...provisional, committed: committedOf(result) };
      changed.push(path);
    } else if (previous) {
      files[path] = previous;
      markExternalChange(files, path, preimage);
    } else {
      delete files[path];
    }
  }
  persist();
  if (failure !== null) throw failure;
  return { changed };
}

/**
 * rh reverts a file only while it hashes to `committed` and has no external
 * change: then the backup (or, for a created file, no file) is exactly the
 * state before rh, whatever the order of rh's edits. Any other file stays,
 * with its records. Created directories go after all files; a directory that
 * still holds content keeps its record for a later revert.
 */
function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined, dryRun: boolean): HostConfigRevertEntry[] {
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const report: HostConfigRevertEntry[] = [];
  const targets = only ? only.map((path) => resolveHostPath(paths, path)) : (Object.keys(ledger.files) as HostPath[]);
  for (const path of targets) {
    const record = files[path];
    if (!record) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    if (record.external_change || !isCommitted(record, current)) {
      report.push({ path, action: 'kept_edited' });
      continue;
    }
    let action: HostConfigRevertEntry['action'];
    if (record.kind === 'created') {
      if (current.existed && !dryRun) removeTarget(path, current);
      action = 'removed';
    } else {
      const backup = readVault(paths, record.backup!);
      if (bytes !== null && backup.equals(bytes)) action = 'released';
      else {
        if (!dryRun) replaceTarget(path, backup, current);
        action = record.kind === 'replaced' ? 'restored' : 'text_removed';
      }
    }
    delete files[path];
    fragments = fragments.filter((entry) => entry.file !== path);
    report.push({ path, action });
  }
  if (dryRun) return report;
  const attempted = only ? ledger.directories.filter((directory) => targets.some((path) => isPathInside(directory, path))) : ledger.directories;
  const kept = removeCreatedDirectories(attempted);
  const directories = ledger.directories.filter((directory) => !attempted.includes(directory) || kept.includes(directory));
  writeLedger(paths, { protocol: 1, files, fragments, directories });
  return report;
}

function adoptFile(paths: HostConfigPaths, target: string, adoption: HostConfigAdoption): 'adopted' | 'recorded' {
  const [path] = admitPaths(paths, [target]) as [HostPath];
  const ledger = readLedger(paths);
  if (ledger.files[path]) return 'recorded';
  const current = expectedOf(observeFile(path).observation, path);
  const record: FileRecord = {
    kind: adoption.backup === null ? 'created' : 'text_block',
    baseline: { state: 'unknown' },
    committed: committedOf(current),
    backup: adoption.backup === null ? null : putVault(paths, adoption.backup),
    external_change: adoption.externalChange,
  };
  const fragments = adoption.fragments.map((fragment) => ({ file: path, ...fragment }));
  writeLedger(paths, { ...ledger, files: { ...ledger.files, [path]: record }, fragments: [...ledger.fragments, ...fragments] });
  return 'adopted';
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const paths = hostConfigPaths(options.env ?? process.env);
  return {
    apply: (changes) => applyChanges(paths, changes),
    delegate: (declaredPaths, run) => delegateWrite(paths, declaredPaths, run),
    revert: (only, revertOptions) => revertFiles(paths, only, revertOptions?.dryRun === true),
    adopt: (path, adoption) => adoptFile(paths, path, adoption),
  };
}
