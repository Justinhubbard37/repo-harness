import { readFileSync, rmSync } from 'node:fs';
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
  type PathCommitted,
  type PathRecord,
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
  hostPathKey,
  pathRecordOf,
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
import { pathRecordHost, pathRecordIsCurrent } from './path-records';
import {
  discardStagedEntry,
  hasPreimage,
  keepPreimage,
  observePathEntry,
  publishPathEntry,
  removePathEntry,
  restorePreimage,
  sameCommitted,
  stagePathEntry,
  type PathEntry,
} from './whole-path';

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
  /** The path-record keys whose entry the writer changed. */
  readonly changed: readonly string[];
}

/** One whole entry for the gate to write at a host path, owned by `owner` (`core` or a plugin id). */
export interface HostConfigPathWrite {
  readonly path: string;
  readonly owner: string;
  readonly entry: PathEntry;
  /**
   * The user's word to replace a file that rh does not own (`--force`): the
   * gate keeps that file in the vault first and records `replaced`.
   */
  readonly replace?: boolean;
}

/** A host path that an out-of-process writer may write, owned by `owner`. */
export interface HostConfigPathDeclaration {
  readonly path: string;
  readonly owner: string;
  /** As in `HostConfigPathWrite`: the writer may replace a file that rh does not own. */
  readonly replace?: boolean;
}

export interface HostConfigPathOptions {
  /**
   * The runtime transaction directory. Before the gate replaces or removes an
   * entry that rh owns, it keeps a copy here, so a rollback of the transaction
   * can put it back; the transaction deletes the directory at commit.
   */
  readonly transaction?: string;
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
   * Write whole entries (a file, a link, a directory tree) and record each as
   * a path record before it is published. An existing path must be rh's (a
   * current record of the same owner); any other existing path is refused,
   * except a file under `replace`, which goes to the vault first.
   */
  writePaths(writes: readonly HostConfigPathWrite[], options?: HostConfigPathOptions): readonly string[];
  /**
   * Only for out-of-process writers: `run` gets the path-record keys (parent
   * links followed, leaf kept) and may write them. The gate keeps the files
   * that `replace` lets the writer replace in the vault before `run`, and
   * records each entry that the writer changed after it. A changed path that
   * rh did not own and that `replace` did not allow is reported and not
   * recorded.
   */
  delegate(declared: readonly HostConfigPathDeclaration[], run: (destinations: readonly string[]) => void, options?: HostConfigPathOptions): HostConfigDelegateResult;
  /**
   * Undo the path records of the named paths, which the caller takes from the
   * records that may grant a removal (`readPathRecords`): a `created` entry goes
   * while it is current, a `replaced` file gets the user file back while it
   * still holds rh's bytes, and a `user_managed` record is released. A changed
   * entry stays with its record and is reported `kept_edited`.
   */
  revertPaths(paths: readonly string[], options?: HostConfigPathOptions): readonly HostConfigRevertEntry[];
  /**
   * The user's word that they keep each file in `kept`: its record becomes
   * `user_managed` with the file's current hash. Every other `user_managed`
   * record of a path in `scope` goes. `kept` must be inside `scope`.
   */
  keepUserPaths(owner: string, scope: readonly string[], kept: readonly string[]): void;
  /**
   * One-shot migration: rh's current file at `path` replaced the user file
   * `backup` before the ledger had path records. The backup goes to the vault
   * and the record becomes `replaced`. The path must have no record or a
   * current `created` record of `owner`.
   */
  adoptReplacedPath(path: string, owner: string, backup: Buffer): void;
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

/**
 * An install owns the whole path of a path record (a skill, a link, a fleet
 * file); no gate operation acts on it until #2850 gives the gate that strategy.
 */
function refuseRecordedPaths(ledger: HostConfigLedger, targets: readonly HostPath[]): void {
  for (const target of targets) {
    const key = pathRecordOf(ledger, target);
    if (key !== null) throw new HostConfigError('host_config_invalid_state', `an install owns this whole path (${key}), so the gate does not write it: ${target}`);
  }
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
  // The first backup stays the restore target; a later copy of an outside edit is kept apart for the report. A file
  // that rh adopted has no backup: its first copy, taken while it holds what rh recorded, becomes the restore target.
  const adopted = previous.backup === null && isCommitted(previous, preimage) ? first.backup : null;
  const externalBackup = adopted ? previous.external_backup : first.backup ?? previous.external_backup;
  return {
    ...previous,
    backup: previous.backup ?? adopted,
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

/**
 * The whole file goes to the vault before rh writes over bytes that rh did not
 * write. A file as rh recorded it needs no copy when its backup already holds
 * those bytes or when rh wrote all of it (`created`); an adopted file has
 * neither, so an edit that removes user bytes copies it.
 */
function backupUserBytes(paths: HostConfigPaths, previous: FileRecord | undefined, preimage: ExpectedFile, bytes: Buffer | null, removesUserBytes: boolean): Sha256 | null {
  if (bytes === null) return null;
  const copied = previous && isCommitted(previous, preimage) && (!removesUserBytes || previous.backup !== null || previous.kind === 'created');
  return copied ? null : putVault(paths, bytes);
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
        ...(previous?.separator !== undefined ? { separator: previous.separator } : {}),
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
  refuseRecordedPaths(ledger, targets);
  const persist = () => writeLedger(paths, { ...ledger, files, fragments, directories });
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
    const removesUserBytes = !plan.fragments.every(keepsUserBytes);
    const backup = change.backup === 'overrides-only' && !removesUserBytes ? null : backupUserBytes(paths, previous, preimage, bytes, removesUserBytes);
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

// ---- whole paths --------------------------------------------------------

/** A path record key, the host that the install root names, and the record of another key whose directory holds it. */
function admitWholePath(env: NodeJS.ProcessEnv, paths: HostConfigPaths, ledger: HostConfigLedger, path: string): { key: string; host: PathRecord['host'] } {
  const key = hostPathKey(paths, path);
  const host = pathRecordHost(env, path);
  if (host === null) throw new HostConfigError('host_config_invalid_path', `not inside an install root, so rh records no whole path there: ${path}`);
  const holder = pathRecordOf(ledger, key as HostPath);
  if (holder !== null && holder !== key) throw new HostConfigError('host_config_invalid_state', `the recorded directory ${holder} holds this path, so rh does not write it on its own: ${path}`);
  // A whole entry would replace rh's text blocks and the user's bytes around them with no record of either.
  if (ledger.files[key]?.kind === 'text_block') throw new HostConfigError('host_config_invalid_state', `rh text blocks are recorded in this file, so rh does not write it as a whole path: ${path}`);
  return { key, host };
}

/** True when the entry at the key is rh's to replace for `owner`: a current record of that owner that the user does not keep. */
function ownsEntry(record: PathRecord | undefined, owner: string, key: string): record is PathRecord {
  return record !== undefined && record.owner === owner && record.kind !== 'user_managed' && pathRecordIsCurrent(key, record);
}

function refusal(path: string, record: PathRecord | undefined, owner: string): HostConfigError {
  const reason = !record ? 'rh has no record of it' : record.owner !== owner ? `rh records it for ${record.owner}`
    : record.kind === 'user_managed' ? 'the user keeps it' : 'it changed since rh wrote it';
  return new HostConfigError('host_config_invalid_state', `${reason}, so rh does not replace it: ${path}`);
}

/** The bytes of a user file that `replace` lets rh write over, in the vault; only a regular file qualifies. */
function vaultUserFile(paths: HostConfigPaths, key: string, observed: PathCommitted, path: string): Sha256 {
  if (observed.type !== 'file') throw new HostConfigError('host_config_invalid_state', `only a file can be replaced on the user's word: ${path}`);
  return putVault(paths, readFileSync(key));
}

function nextPathRecord(previous: PathRecord | undefined, owner: string, host: PathRecord['host'], observed: PathCommitted | null,
  committed: PathCommitted, backup: Sha256 | undefined): PathRecord {
  const baseline = previous?.baseline ?? (observed === null ? { state: 'known' as const, existed: false as const }
    : observed.type === 'file' ? { state: 'known' as const, existed: true as const, sha256: observed.sha256 } : { state: 'unknown' as const });
  const kept = backup ?? (previous?.kind === 'replaced' ? previous.backup : undefined);
  return { owner, host, kind: kept ? 'replaced' : 'created', baseline, committed, ...(kept ? { backup: kept } : {}) };
}

/** `validPathRecord` holds a `replaced` record to a file: the user file that it replaced comes back as a file. */
function assertReplacedIsFile(record: PathRecord, path: string): void {
  if (record.kind === 'replaced' && record.committed.type !== 'file') {
    throw new HostConfigError('host_config_invalid_state', `rh replaced a user file here, so it writes only a file at this path: ${path}`);
  }
}

/** Each record reaches the ledger before its entry is published, so every whole-path write has its record. */
function writeWholePaths(env: NodeJS.ProcessEnv, paths: HostConfigPaths, writes: readonly HostConfigPathWrite[], options: HostConfigPathOptions): string[] {
  const ledger = readLedger(paths);
  const records = { ...ledger.paths };
  let directories = ledger.directories;
  const persist = () => writeLedger(paths, { ...ledger, paths: records, directories });
  const admitted = writes.map((write) => ({ write, ...admitWholePath(env, paths, ledger, write.path) }));
  if (new Set(admitted.map(({ key }) => key)).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  const written: string[] = [];
  for (const { write, key, host } of admitted) {
    const previous = records[key];
    const observed = observePathEntry(key);
    let backup: Sha256 | undefined;
    if (observed !== null && !ownsEntry(previous, write.owner, key)) {
      if (!write.replace) throw refusal(write.path, previous, write.owner);
      backup = vaultUserFile(paths, key, observed, write.path);
    }
    const createdDirs = missingDirectories(key as HostPath);
    createDirectories(createdDirs);
    let staged: string | null = null;
    try {
      const stage = stagePathEntry(key, write.entry);
      staged = stage.staged;
      const next = nextPathRecord(previous, write.owner, host, observed, stage.committed, backup);
      assertReplacedIsFile(next, write.path);
      if (sameCommitted(observed, stage.committed) && previous && JSON.stringify(previous) === JSON.stringify(next)) {
        discardStagedEntry(staged);
        continue;
      }
      if (backup === undefined && options.transaction) keepPreimage(options.transaction, key);
      records[key] = next;
      directories = [...directories, ...createdDirs];
      persist();
      publishPathEntry(staged, key);
      staged = null;
      written.push(key);
    } catch (error) {
      if (staged) discardStagedEntry(staged);
      if (previous) records[key] = previous; else delete records[key];
      directories = directories.filter((directory) => !createdDirs.includes(directory));
      removeCreatedDirectories(createdDirs);
      persist();
      throw error;
    }
  }
  return written;
}

/**
 * The out-of-process form of `writeWholePaths`. Every destination is checked
 * before `run`: an existing entry must be rh's, or a file under `replace`,
 * which goes to the vault first; any other destination stops the call before
 * the writer runs. Records follow the writer: a path that it did not change
 * keeps the record that the ledger then holds, so the writer's own record
 * changes (a `user_managed` claim) stay.
 */
function delegateWholePaths(env: NodeJS.ProcessEnv, paths: HostConfigPaths, declared: readonly HostConfigPathDeclaration[],
  run: (destinations: readonly string[]) => void, options: HostConfigPathOptions): HostConfigDelegateResult {
  const ledger = readLedger(paths);
  const admitted = declared.map((declaration) => ({ declaration, ...admitWholePath(env, paths, ledger, declaration.path) }));
  if (new Set(admitted.map(({ key }) => key)).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  const checked = admitted.map(({ declaration, key, host }) => {
    const previous = ledger.paths[key];
    const observed = observePathEntry(key);
    const owned = observed === null || ownsEntry(previous, declaration.owner, key);
    if (!owned && !(declaration.replace && observed.type === 'file')) {
      throw observed.type === 'file' || !declaration.replace ? refusal(declaration.path, previous, declaration.owner)
        : new HostConfigError('host_config_invalid_state', `only a file can be replaced on the user's word: ${declaration.path}`);
    }
    return { declaration, key, host, previous, observed, owned };
  });
  const before = checked.map((entry) => {
    const backup = entry.owned ? undefined : putVault(paths, readFileSync(entry.key));
    if (entry.owned && options.transaction) keepPreimage(options.transaction, entry.key);
    return { ...entry, backup };
  });
  let failure: unknown = null;
  try { run(admitted.map(({ key }) => key)); } catch (error) { failure = error; }

  const after = readLedger(paths);
  const records = { ...after.paths };
  const changed: string[] = [];
  const invalid: string[] = [];
  for (const { declaration, key, host, previous, observed, owned, backup } of before) {
    const now = observePathEntry(key);
    if (sameCommitted(now, observed)) continue;
    // A failed replacement must keep the vault reference, also when the writer removed the entry.
    if ((backup !== undefined || previous?.kind === 'replaced') && now?.type !== 'file') {
      records[key] = backup !== undefined
        ? nextPathRecord(undefined, declaration.owner, host, observed, observed!, backup)
        : previous!;
      invalid.push(declaration.path);
      continue;
    }
    const next = now === null ? null : nextPathRecord(owned ? previous : undefined, declaration.owner, host, observed, now, backup);
    if (next === null) delete records[key]; else records[key] = next;
    changed.push(key);
  }
  writeLedger(paths, { ...after, paths: records });
  if (failure !== null) throw failure;
  if (invalid.length) throw new HostConfigError('host_config_invalid_state', `rh replaced a user file at these paths, but the delegated writer did not leave a file there: ${invalid.join(', ')}`);
  return { changed };
}

function keepUserPaths(env: NodeJS.ProcessEnv, paths: HostConfigPaths, owner: string, scope: readonly string[], kept: readonly string[]): void {
  const ledger = readLedger(paths);
  const records = { ...ledger.paths };
  const inScope = new Map(scope.map((path) => { const admitted = admitWholePath(env, paths, ledger, path); return [admitted.key, admitted.host]; }));
  for (const key of inScope.keys()) if (records[key]?.kind === 'user_managed') delete records[key];
  for (const path of kept) {
    const key = hostPathKey(paths, path);
    const host = inScope.get(key);
    if (host === undefined) throw new HostConfigError('host_config_invalid_path', `a kept path must be inside the scope: ${path}`);
    const committed = observePathEntry(key);
    if (committed?.type !== 'file') throw new HostConfigError('host_config_invalid_state', `the user keeps only a file: ${path}`);
    records[key] = { owner, host, kind: 'user_managed', baseline: { state: 'unknown' }, committed };
  }
  writeLedger(paths, { ...ledger, paths: records });
}

function adoptReplacedPath(env: NodeJS.ProcessEnv, paths: HostConfigPaths, path: string, owner: string, backup: Buffer): void {
  const ledger = readLedger(paths);
  const { key, host } = admitWholePath(env, paths, ledger, path);
  const previous = ledger.paths[key];
  const committed = observePathEntry(key);
  if (committed?.type !== 'file') throw new HostConfigError('host_config_invalid_state', `only a file can have replaced a user file: ${path}`);
  if (previous && !(previous.kind === 'created' && ownsEntry(previous, owner, key))) throw refusal(path, previous, owner);
  const record: PathRecord = { owner, host, kind: 'replaced', baseline: previous?.baseline ?? { state: 'unknown' }, committed, backup: putVault(paths, backup) };
  writeLedger(paths, { ...ledger, paths: { ...ledger.paths, [key]: record } });
}

/**
 * The undo that a path record gets now, with no write: a caller that plans
 * from records that the ledger does not hold yet (a dry-run migration) uses
 * the same rule as `revertPaths`.
 */
export function planPathRevert(key: string, record: PathRecord): HostConfigRevertEntry['action'] {
  if (record.kind === 'user_managed') return 'released';
  if (observePathEntry(key) === null) return record.kind === 'created' ? 'released' : 'kept_edited';
  if (!pathRecordIsCurrent(key, record)) return 'kept_edited';
  return record.kind === 'replaced' ? 'restored' : 'removed';
}

function revertWholePath(paths: HostConfigPaths, key: string, record: PathRecord, transaction: string | undefined): HostConfigRevertEntry['action'] {
  const action = planPathRevert(key, record);
  if (action !== 'restored' && action !== 'removed') return action;
  if (transaction) keepPreimage(transaction, key);
  if (record.kind === 'replaced') {
    const committed = record.committed as Extract<PathCommitted, { type: 'file' }>;
    replaceTarget(key as HostPath, readVault(paths, record.backup!), { existed: true, sha256: committed.sha256 });
  } else removePathEntry(key);
  return action;
}

function revertWholePaths(paths: HostConfigPaths, only: readonly string[], options: HostConfigPathOptions): HostConfigRevertEntry[] {
  const ledger = readLedger(paths);
  const records = { ...ledger.paths };
  const keys = only.map((path) => hostPathKey(paths, path));
  const report: HostConfigRevertEntry[] = [];
  const dropped: string[] = [];
  for (const key of keys) {
    const record = records[key];
    if (!record) continue;
    const action = revertWholePath(paths, key, record, options.transaction);
    if (action !== 'kept_edited') { delete records[key]; dropped.push(key); }
    report.push({ path: key, action });
  }
  const attempted = ledger.directories.filter((directory) => dropped.some((key) => isPathInside(directory, key)));
  const kept = removeCreatedDirectories(attempted);
  const directories = ledger.directories.filter((directory) => !attempted.includes(directory) || kept.includes(directory));
  writeLedger(paths, { ...ledger, paths: records, directories });
  return report;
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
  const removed: FragmentRecord[] = [];
  const kept: string[] = [];
  for (const record of records) {
    const format = fragmentFormat(path, record.selector);
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
    return { entry: { path, action: 'text_removed' }, write: { kind: 'replace', content: backup }, record: 'drop', removed: all };
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
  // A changed file with no fragment to take out (a created file) stays with its record.
  if (!removed.size && !(kind === 'text_block' && !input.hasBackup)) return { entry: withKept('kept_edited'), write: null, record: 'keep', removed: [] };
  const empty = kind === 'created' && all.some((record) => fragmentFormat(path, record.selector)?.empty(result.content) === true);
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
  refuseRecordedPaths(ledger, targets);
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
  writeLedger(paths, { ...ledger, files, fragments, directories });
  return report;
}

function adoptFile(paths: HostConfigPaths, target: string, adoption: HostConfigAdoption): 'adopted' | 'recorded' {
  const [path] = admitPaths(paths, [target]) as [HostPath];
  const ledger = readLedger(paths);
  refuseRecordedPaths(ledger, [path]);
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
 * as it was before the transaction (`snapshot`, null when there was none), and
 * the transaction directory that holds the path preimages (`transaction`). It
 * writes the host files and then the ledger: the snapshot's records, except
 * the path record of each entry that it cannot undo, which stays so that the
 * entry keeps its owner.
 * For each file whose records changed, an intact fragment goes back to its
 * state before the transaction: to its snapshot text after a refresh, to its
 * adopted text when the transaction adopted it, out when the transaction
 * added it, and to its backup text when the transaction overrode a user
 * value. A file of which the transaction took a whole copy goes back to that
 * copy first. A file that the transaction created goes only when the file did not
 * exist before it and still holds exactly what it wrote. Every other entry
 * stays and is returned.
 */
export function rollbackHostConfigTransaction(harness: string, snapshot: Buffer | null, transaction: string): HostConfigRollbackResult {
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
    if (bytes === null || !isCommitted(record, current)) {
      unresolved.push(...changed.map((entry) => `${path}: ${entry.selector}`));
      continue;
    }
    // The bytes before an override in this transaction: the copy that it took of an outside edit, or the first backup.
    const source = previous && record.external_backup !== previous.external_backup ? record.external_backup : record.backup;
    const backup = source ? decode(readVault(paths, source), path) : null;
    // A whole-file copy that this transaction took holds every byte that its later writes changed, also outside the
    // fragments (a legacy migration): the file goes back to it, and only a fragment that it still shows as written,
    // by an earlier write of this transaction, gets its own edit.
    const copy = !previous || record.backup !== previous.backup ? record.backup
      : record.external_backup !== previous.external_backup ? record.external_backup ?? null : null;
    let content = decode(copy ? readVault(paths, copy) : bytes, path);
    for (const entry of [...changed].reverse()) {
      const format = fragmentFormat(path, entry.selector);
      const range = format?.strategy.locate(content, entry.selector) ?? null;
      const old = earlier.find((candidate) => fragmentKey(candidate) === fragmentKey(entry));
      if (copy && (!range || content.slice(range.start, range.end) !== entry.inserted)) continue;
      if (!format || !range || content.slice(range.start, range.end) !== entry.inserted || (!old && entry.preimage === undefined && entry.kind !== 'add' && backup === null)) {
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
    if (created && all.some((entry) => fragmentFormat(path, entry.selector)?.empty(content) === true)) removeTarget(path, current);
    else if (content !== decode(bytes, path)) replaceTarget(path, Buffer.from(content, 'utf8'), current);
  }
  const pathRecords = rollbackWholePaths(paths, before, now, transaction, unresolved);
  const kept = removeCreatedDirectories(now.directories.filter((directory) => !before.directories.includes(directory)));
  const restored: HostConfigLedger = { ...before, paths: pathRecords, directories: [...before.directories, ...kept] };
  // No ledger before the transaction and no record left: the ledger file goes, as it was.
  if (snapshot === null && JSON.stringify(restored) === JSON.stringify(EMPTY_LEDGER)) rmSync(paths.ledger, { force: true });
  else writeLedger(paths, restored);
  return { unresolved };
}

/**
 * The path records after a rollback. A path that the transaction wrote goes
 * back to its entry before the transaction: out when it was absent, the user
 * file from the vault when the transaction replaced one, and the transaction's
 * preimage when it refreshed or removed rh's entry. An entry that is no longer
 * what the transaction recorded stays with that record, and is returned.
 */
function rollbackWholePaths(paths: HostConfigPaths, before: HostConfigLedger, now: HostConfigLedger, transaction: string, unresolved: string[]): Record<string, PathRecord> {
  const records: Record<string, PathRecord> = { ...before.paths };
  for (const key of new Set([...Object.keys(before.paths), ...Object.keys(now.paths)])) {
    const old = before.paths[key];
    const current = now.paths[key];
    if (JSON.stringify(old) === JSON.stringify(current) && !hasPreimage(transaction, key)) continue;
    // A claim or release of a file that the user keeps changes no entry.
    if (current?.kind === 'user_managed' || (!current && old?.kind === 'user_managed')) continue;
    if (!current) {
      const entry = observePathEntry(key);
      // A revert in this transaction took the record out: the entry is gone, or it is the user file that came back from the vault.
      const reverted = entry === null || (old!.kind === 'replaced' && entry.type === 'file' && entry.sha256 === old!.backup);
      if (reverted && hasPreimage(transaction, key)) restorePreimage(transaction, key);
      else if (!pathRecordIsCurrent(key, old!)) unresolved.push(key);
      continue;
    }
    if (!pathRecordIsCurrent(key, current)) { records[key] = current; unresolved.push(key); continue; }
    if (current.kind === 'replaced' && current.backup !== old?.backup) {
      const committed = current.committed as Extract<PathCommitted, { type: 'file' }>;
      replaceTarget(key as HostPath, readVault(paths, current.backup!), { existed: true, sha256: committed.sha256 });
    } else if (!old) removePathEntry(key);
    else if (hasPreimage(transaction, key)) restorePreimage(transaction, key);
    else { records[key] = current; unresolved.push(key); }
  }
  return records;
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const env = options.env ?? process.env;
  const paths = hostConfigPaths(env);
  return {
    apply: (changes) => applyChanges(paths, changes),
    writePaths: (writes, pathOptions) => writeWholePaths(env, paths, writes, pathOptions ?? {}),
    delegate: (declared, run, pathOptions) => delegateWholePaths(env, paths, declared, run, pathOptions ?? {}),
    revertPaths: (only, revertOptions) => revertWholePaths(paths, only, revertOptions ?? {}),
    keepUserPaths: (owner, scope, kept) => keepUserPaths(env, paths, owner, scope, kept),
    adoptReplacedPath: (path, owner, backup) => adoptReplacedPath(env, paths, path, owner, backup),
    revert: (only, revertOptions) => revertFiles(paths, only, revertOptions ?? {}),
    adopt: (path, adoption) => adoptFile(paths, path, adoption),
    recorded: (path) => {
      const resolved = resolveHostPath(paths, path);
      return readLedger(paths).fragments.filter((entry) => entry.file === resolved);
    },
  };
}
