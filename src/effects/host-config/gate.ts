import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import { fragmentFormat } from '../../core/host-config/registry';
import {
  HostConfigError,
  expectedFromCommitted,
  sameExpected,
  type ExpectedFile,
  type FileCommitted,
  type FileRecord,
  type FileRecordKind,
  type FragmentEdit,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigBackupPolicy,
  EMPTY_LEDGER,
  type HostConfigLedger,
  type HostPath,
  type Sha256,
  type SkippedOverride,
  type TextRange,
} from '../../core/host-config/types';
import {
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  hostConfigPathsAt,
  missingDirectories,
  observeFile,
  parseLedger,
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
  /** Default `whole-file`. */
  readonly backup?: HostConfigBackupPolicy;
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
  /** The selectors of the fragments that stay in a kept file. */
  readonly kept?: readonly string[];
}

/** A fragment that an earlier rh version wrote, as its old record names it. */
export interface AdoptedFragment {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  readonly inserted: string;
  readonly preimage?: string;
}

/**
 * One-shot migration of a file that an earlier rh version wrote before the
 * ledger existed. `backup` is the file before rh, rebuilt from the old record.
 * The kind is `created` when `backup` is null, unless the migration names
 * `text_block` for a file that rh only added to and keeps no copy of.
 */
export interface HostConfigAdoption {
  readonly kind?: 'created' | 'text_block';
  readonly backup: Buffer | null;
  readonly fragments: readonly AdoptedFragment[];
  readonly externalChange: boolean;
}

export interface HostConfigRevertOptions {
  /** Report what the revert would do and write nothing. */
  readonly dryRun?: boolean;
  /** Take out only the fragments of this owner; the file records stay. */
  readonly owner?: string;
  /** Take out only the fragments at these selectors; the file records stay. */
  readonly selectors?: readonly string[];
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
  /**
   * Undo rh's recorded writes, for the named paths or for all; a path without
   * a record is not touched. With an owner or selector filter, only the
   * matching fragments go, by the per-fragment rule.
   */
  revert(paths?: readonly string[], options?: HostConfigRevertOptions): readonly HostConfigRevertEntry[];
  /**
   * Record a file that has no record, with `baseline.state: unknown` and
   * `committed` set to the current file. It writes no host file. A path that
   * already has a record keeps it (`recorded`), so a migration can run again.
   */
  adopt(path: string, adoption: HostConfigAdoption): 'adopted' | 'recorded';
  /** The fragment records of one path, its links followed. */
  recorded(path: string): readonly FragmentRecord[];
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
  // The first backup stays the restore target; a later copy of an outside edit is kept apart for the report.
  const externalBackup = first.backup ?? previous.external_backup;
  return {
    ...previous,
    committed: committedOf(written),
    ...(externalBackup ? { external_backup: externalBackup } : {}),
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
  return !fragment.previous || fragment.previous.inserted !== fragment.text;
}

/** True when the edit replaces no bytes, or only the text that rh recorded at the selector. */
function keepsUserBytes(fragment: PlannedFragment): boolean {
  return fragment.edit.removed === '' || fragment.previous?.inserted === fragment.edit.removed;
}

/** The whole file goes to the vault before rh writes over bytes that rh did not write. */
function backupUserBytes(paths: HostConfigPaths, previous: FileRecord | undefined, preimage: ExpectedFile, bytes: Buffer | null): Sha256 | null {
  return bytes !== null && (!previous || !isCommitted(previous, preimage)) ? putVault(paths, bytes) : null;
}

/**
 * The fragment records of one file after its plan: a planned fragment replaces
 * the record of its owner and selector. The first kind stays, so a refresh of
 * an `add` is still removable by the per-fragment revert.
 */
function fileFragments(plan: FilePlan, recorded: readonly FragmentRecord[]): FragmentRecord[] {
  const replaced = new Set(plan.fragments.map((fragment) => fragment.previous));
  return [
    ...recorded.filter((entry) => !replaced.has(entry)),
    ...plan.fragments.map(({ owner, selector, kind, previous, text, created }): FragmentRecord => {
      const container = previous?.created ?? created;
      return { file: plan.file, owner, selector, kind: previous?.kind ?? kind, inserted: text, ...(container ? { created: container } : {}),
        ...(previous?.preimage !== undefined ? { preimage: previous.preimage } : {}) };
    }),
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
    const backup = change.backup === 'overrides-only' && plan.fragments.every(keepsUserBytes) ? null : backupUserBytes(paths, previous, preimage, bytes);
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

interface FragmentRevert {
  readonly content: string;
  readonly removed: readonly FragmentRecord[];
  readonly kept: readonly string[];
}

/**
 * The per-fragment rule: a fragment goes only while the text at its selector
 * is still byte-identical to what rh recorded. An `add` is taken out. An
 * override (or a selected refresh of text that rh never recorded) is set back
 * to its text in the backup, which holds the file before rh's first write
 * over the user's bytes and never changes; with no backup it stays. Every
 * other fragment stays. `all` holds every record of the file: a container
 * that a removal empties goes only when one of them proves that rh created it.
 */
function revertFragments(path: string, content: string, records: readonly FragmentRecord[], all: readonly FragmentRecord[], backup: string | null): FragmentRevert {
  const format = fragmentFormat(path);
  const removed: FragmentRecord[] = [];
  const kept: string[] = [];
  for (const record of records) {
    let range: TextRange | null = null;
    // A file that the strategy can no longer read keeps every fragment.
    try { range = format?.strategy.locate(content, record.selector) ?? null; } catch (error) { if (!(error instanceof HostConfigError)) throw error; }
    const intact = format !== null && record.inserted !== '' && range !== null && content.slice(range.start, range.end) === record.inserted;
    if (!format || !intact || (record.kind !== 'add' && backup === null)) {
      kept.push(record.selector);
      continue;
    }
    const edit = record.kind === 'add' ? format.remove(content, record.selector, all) : format.restore(content, record.selector, backup!, all);
    content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    removed.push(record);
  }
  return { content, removed, kept };
}

/** What a revert knows about one recorded file. */
export interface FileRevertInput {
  readonly path: string;
  readonly kind: FileRecord['kind'];
  readonly hasBackup: boolean;
  readonly externalChange: boolean;
  /** The file hashes to the record's `committed`. */
  readonly committed: boolean;
  readonly existed: boolean;
  /** The file's bytes; null when it is missing or not a regular file. */
  readonly bytes: Buffer | null;
  /** The bytes before rh, for the whole-file restore. */
  readonly backup: () => Buffer;
  /** The records that this revert takes out, after its filter. */
  readonly own: readonly FragmentRecord[];
  /** Every record of the file. */
  readonly all: readonly FragmentRecord[];
  readonly filtered: boolean;
}

export interface FileRevertPlan {
  readonly entry: HostConfigRevertEntry;
  readonly write: { readonly kind: 'remove' } | { readonly kind: 'replace'; readonly content: Buffer } | null;
  /** `drop`: the file record goes; `update`: it stays and `committed` follows the write; `keep`: it stays as it is. */
  readonly record: 'drop' | 'update' | 'keep';
  readonly removed: readonly FragmentRecord[];
}

/**
 * The revert of one recorded file, with no read or write: `revert` carries it
 * out, and a dry run before a migration reports it for records not written yet.
 */
export function planFileRevert(input: FileRevertInput): FileRevertPlan {
  const { path, kind, own, all, filtered } = input;
  if (!filtered && !input.externalChange && input.committed && (kind === 'created' || input.hasBackup)) {
    if (kind === 'created') return { entry: { path, action: 'removed' }, write: input.existed ? { kind: 'remove' } : null, record: 'drop', removed: all };
    const backup = input.backup();
    if (input.bytes !== null && backup.equals(input.bytes)) return { entry: { path, action: 'released' }, write: null, record: 'drop', removed: all };
    return { entry: { path, action: kind === 'replaced' ? 'restored' : 'text_removed' }, write: { kind: 'replace', content: backup }, record: 'drop', removed: all };
  }
  if (!input.existed || input.bytes === null) return { entry: { path, action: 'kept_edited', kept: own.map((entry) => entry.selector) }, write: null, record: 'keep', removed: [] };
  const result = revertFragments(path, decode(input.bytes, path), own, all, input.hasBackup ? decode(input.backup(), path) : null);
  const removed = new Set(result.removed);
  const remaining = all.filter((entry) => !removed.has(entry));
  const content = Buffer.from(result.content, 'utf8');
  const withKept = (action: HostConfigRevertEntry['action']): HostConfigRevertEntry => result.kept.length ? { path, action, kept: result.kept } : { path, action };
  if (filtered || result.kept.length || remaining.length) {
    // The file keeps its record; `committed` follows the write, and an outside edit stays recorded.
    const action = result.kept.length || !removed.size ? 'kept_edited' : 'text_removed';
    return { entry: withKept(action), write: removed.size ? { kind: 'replace', content } : null, record: removed.size ? 'update' : 'keep', removed: result.removed };
  }
  // A changed file with no fragment to take out (a created or replaced file) stays with its record.
  if (!removed.size && !(kind === 'text_block' && !input.hasBackup)) return { entry: withKept('kept_edited'), write: null, record: 'keep', removed: [] };
  const empty = kind === 'created' && fragmentFormat(path)?.empty(result.content) === true;
  const write = empty ? { kind: 'remove' as const } : removed.size ? { kind: 'replace' as const, content } : null;
  return { entry: withKept(empty ? 'removed' : removed.size ? 'text_removed' : 'released'), write, record: 'drop', removed: result.removed };
}

interface RevertFilter {
  readonly owner?: string;
  readonly selectors?: readonly string[];
}

function matchesFilter(record: FragmentRecord, filter: RevertFilter): boolean {
  return (filter.owner === undefined || record.owner === filter.owner) && (filter.selectors === undefined || filter.selectors.includes(record.selector));
}

/**
 * A file that hashes to `committed` with no external change and a backup (or
 * that rh created) reverts as a whole: the backup, or no file, is exactly the
 * state before rh, whatever the order of rh's edits. Any other file, and every
 * file under an owner or selector filter, goes by the per-fragment rule; the
 * file keeps its record while a fragment of it stays. Created directories go
 * after all files, only in an unfiltered revert; a directory that still holds
 * content keeps its record for a later revert.
 */
function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined, options: HostConfigRevertOptions): HostConfigRevertEntry[] {
  const dryRun = options.dryRun === true;
  const filter: RevertFilter = { owner: options.owner, selectors: options.selectors };
  const filtered = filter.owner !== undefined || filter.selectors !== undefined;
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
    const all = fragments.filter((entry) => entry.file === path);
    const own = all.filter((entry) => matchesFilter(entry, filter));
    if (filtered && !own.length) continue;
    const plan = planFileRevert({
      path, kind: record.kind, hasBackup: record.backup !== null, externalChange: record.external_change, committed: isCommitted(record, current),
      existed: current.existed, bytes, backup: () => readVault(paths, record.backup!), own, all, filtered,
    });
    if (!dryRun && plan.write) {
      if (plan.write.kind === 'remove') removeTarget(path, current);
      else replaceTarget(path, plan.write.content, current);
    }
    if (plan.record === 'drop') delete files[path];
    else if (plan.record === 'update' && plan.write?.kind === 'replace') {
      files[path] = { ...record, committed: { type: 'file', sha256: sha256Prefixed(plan.write.content) }, external_change: record.external_change || !isCommitted(record, current) };
    }
    const removed = new Set(plan.removed);
    fragments = fragments.filter((entry) => !removed.has(entry));
    report.push(plan.entry);
  }
  if (dryRun) return report;
  const attempted = filtered ? [] : only ? ledger.directories.filter((directory) => targets.some((path) => isPathInside(directory, path))) : ledger.directories;
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
  const kind = adoption.kind ?? (adoption.backup === null ? 'created' : 'text_block');
  if (kind === 'created' && adoption.backup !== null) throw new HostConfigError('host_config_invalid_state', `a created file has no backup: ${path}`);
  const record: FileRecord = {
    kind,
    baseline: { state: 'unknown' },
    committed: committedOf(current),
    backup: adoption.backup === null ? null : putVault(paths, adoption.backup),
    external_change: adoption.externalChange,
  };
  const fragments = adoption.fragments.map((fragment) => ({ file: path, ...fragment }));
  writeLedger(paths, { ...ledger, files: { ...ledger.files, [path]: record }, fragments: [...ledger.fragments, ...fragments] });
  return 'adopted';
}

/** The entries that a transaction rollback could not prove, as `<path>: <selector>`. */
export interface HostConfigRollbackResult {
  readonly unresolved: readonly string[];
}

const fragmentKey = (record: FragmentRecord): string => `${record.owner}\0${record.selector}`;

/**
 * The rollback of the gate writes of one install transaction, from the ledger
 * as it was before the transaction (`snapshot`, null when there was none). It
 * writes host files only; the transaction restores the ledger file after it.
 * For each file whose records changed, an intact fragment goes back to its
 * state before the transaction: to its snapshot text after a refresh, to its
 * adopted text when the transaction adopted it, out when the transaction
 * added it, and to its backup text when the transaction overrode a user
 * value. A file that the transaction created goes only when the file did not
 * exist before it and still holds exactly what it wrote. Every other entry
 * stays and is returned.
 */
export function rollbackHostConfigTransaction(harness: string, snapshot: Buffer | null): HostConfigRollbackResult {
  const paths = hostConfigPathsAt(harness);
  const before = snapshot === null ? EMPTY_LEDGER : parseLedger(snapshot, `${paths.ledger} (transaction snapshot)`);
  const now = readLedger(paths);
  const unresolved: string[] = [];
  for (const path of Object.keys(now.files) as HostPath[]) {
    const record = now.files[path]!;
    const previous = before.files[path];
    const all = now.fragments.filter((entry) => entry.file === path);
    const earlier = before.fragments.filter((entry) => entry.file === path);
    const changed = all.filter((entry) => earlier.find((old) => fragmentKey(old) === fragmentKey(entry))?.inserted !== entry.inserted);
    const dropped = earlier.filter((old) => !all.some((entry) => fragmentKey(entry) === fragmentKey(old)));
    unresolved.push(...dropped.map((old) => `${path}: ${old.selector}`));
    if (!changed.length) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    const format = fragmentFormat(path);
    if (!format || bytes === null || !isCommitted(record, current)) {
      unresolved.push(...changed.map((entry) => `${path}: ${entry.selector}`));
      continue;
    }
    // The bytes before an override in this transaction: the copy that it took of an outside edit, or the first backup.
    const source = previous && record.external_backup !== previous.external_backup ? record.external_backup : record.backup;
    const backup = source ? decode(readVault(paths, source), path) : null;
    let content = decode(bytes, path);
    for (const entry of [...changed].reverse()) {
      const range = format.strategy.locate(content, entry.selector);
      const old = earlier.find((candidate) => fragmentKey(candidate) === fragmentKey(entry));
      if (!range || content.slice(range.start, range.end) !== entry.inserted || (!old && entry.preimage === undefined && entry.kind !== 'add' && backup === null)) {
        unresolved.push(`${path}: ${entry.selector}`);
        continue;
      }
      const edit: FragmentEdit = old ? { at: range.start, removed: entry.inserted, inserted: old.inserted }
        : entry.preimage !== undefined ? { at: range.start, removed: entry.inserted, inserted: entry.preimage }
          : entry.kind === 'add' ? format.remove(content, entry.selector, all)
            : format.restore(content, entry.selector, backup!, all);
      content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    }
    const created = !previous && record.kind === 'created' && record.baseline.state === 'known' && record.baseline.existed === false;
    if (created && format.empty(content)) removeTarget(path, current);
    else if (content !== decode(bytes, path)) replaceTarget(path, Buffer.from(content, 'utf8'), current);
  }
  removeCreatedDirectories(now.directories.filter((directory) => !before.directories.includes(directory)));
  return { unresolved };
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const paths = hostConfigPaths(options.env ?? process.env);
  return {
    apply: (changes) => applyChanges(paths, changes),
    delegate: (declaredPaths, run) => delegateWrite(paths, declaredPaths, run),
    revert: (only, revertOptions) => revertFiles(paths, only, revertOptions ?? {}),
    adopt: (path, adoption) => adoptFile(paths, path, adoption),
    recorded: (path) => {
      const resolved = resolveHostPath(paths, path);
      return readLedger(paths).fragments.filter((entry) => entry.file === resolved);
    },
  };
}
