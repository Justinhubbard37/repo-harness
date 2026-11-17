/**
 * The host-config ledger. It keeps two levels: a file record per host file
 * that rh wrote, and a fragment record per owned text edit. Owner Plan B
 * (#2841): long-term state keeps hashes, rh's own text, and whole-file
 * backups of the user bytes before rh wrote over them. The threat model is accidents (#2841
 * Decisions): user links are followed.
 */

export type HostConfigErrorCode =
  | 'host_config_fragment_overlap'
  | 'host_config_target_changed'
  | 'host_config_invalid_path'
  | 'host_config_invalid_state'
  | 'host_config_unparseable_target';

export class HostConfigError extends Error {
  constructor(readonly code: HostConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HostConfigError';
  }
}

/** `sha256:<hex>` of the exact bytes. */
export type Sha256 = string;

declare const hostPathBrand: unique symbol;
/** A path with the user's links followed, outside `~/.repo-harness/`. */
export type HostPath = string & { readonly [hostPathBrand]: true };

export type FileBaseline =
  | { readonly state: 'known'; readonly existed: false }
  | { readonly state: 'known'; readonly existed: true; readonly sha256: Sha256 }
  /** An earlier rh version wrote the path before the ledger existed. */
  | { readonly state: 'unknown' };

/**
 * How rh first wrote the file: `created` (a new file, a revert removes it),
 * `text_block` (`apply` edited a user file) or `replaced` (a delegated
 * writer replaced a user file); a revert of the last two restores the backup
 * when the record has one.
 */
export type FileRecordKind = 'created' | 'text_block' | 'replaced';

/**
 * When `apply` puts the whole file into the vault: `whole-file` before any
 * write over bytes that rh did not write last; `overrides-only` only when a
 * fragment replaces such bytes, so a file that rh only adds to keeps no copy
 * and a revert removes rh's fragments instead.
 */
export type HostConfigBackupPolicy = 'whole-file' | 'overrides-only';

export type FileCommitted =
  | { readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly type: 'absent' };

export interface FileRecord {
  readonly kind: FileRecordKind;
  readonly baseline: FileBaseline;
  /**
   * The file as rh last wrote it, or as it was when rh last recorded a
   * fragment in it. A revert acts only while the file still hashes to it.
   */
  readonly committed: FileCommitted;
  /**
   * Vault reference of the whole file before rh first wrote over bytes that
   * rh did not write (or the adopted state before rh); required for
   * `replaced`, null for `created` and for a `text_block` that rh only added
   * to under `overrides-only`. It is the restore target and never changes
   * while the record lives.
   */
  readonly backup: Sha256 | null;
  /** Vault reference of the file as an outside edit left it, from the last rh write over it; for the report, never a restore target. */
  readonly external_backup?: Sha256;
  /** Sticky: set once the file differed from `committed` when rh wrote it again. */
  readonly external_change: boolean;
}

export type FragmentKind = 'add' | 'refresh' | 'override';

/** One text edit. `at` is the offset in the content that the edit applies to. */
export interface FragmentEdit {
  readonly at: number;
  readonly removed: string;
  readonly inserted: string;
}

export interface FragmentRecord {
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  /** The text rh wrote at the selector: a refresh over other text is a user's change. Empty when rh's text is not known: the fragment stays. */
  readonly inserted: string;
  /** The outermost container that rh's insert created on the selector's path; a revert removes an emptied container only on this proof. */
  readonly created?: string;
  /** For a fragment that the one-shot migration adopted: its text when adopted, kept across refreshes so that a refreshed value stays recoverable. */
  readonly preimage?: string;
}

export interface HostConfigLedger {
  readonly protocol: 1;
  readonly files: Readonly<Record<string, FileRecord>>;
  readonly fragments: readonly FragmentRecord[];
  /** Directories that rh created and did not remove yet; a revert drops one only when it removes it. */
  readonly directories: readonly string[];
}

export const EMPTY_LEDGER: HostConfigLedger = { protocol: 1, files: {}, fragments: [], directories: [] };

/** The observed state of one path. Only regular files are writable targets. */
export type FileObservation =
  | { readonly existed: false }
  | { readonly existed: true; readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly existed: true; readonly type: 'directory' | 'symlink' | 'other' };

/** The expected state of a path: absent, or a regular file with this hash. */
export type ExpectedFile = { readonly existed: false } | { readonly existed: true; readonly sha256: Sha256 };

export function matchesExpected(observed: FileObservation, expected: ExpectedFile): boolean {
  if (!expected.existed) return !observed.existed;
  return observed.existed && observed.type === 'file' && observed.sha256 === expected.sha256;
}

export function sameExpected(a: ExpectedFile, b: ExpectedFile): boolean {
  return a.existed ? b.existed && a.sha256 === b.sha256 : !b.existed;
}

export function expectedFromCommitted(committed: FileCommitted): ExpectedFile {
  return committed.type === 'absent' ? { existed: false } : { existed: true, sha256: committed.sha256 };
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A strategy owns one file format. It locates a fragment by its selector and
 * returns the text edit that sets the fragment; it never writes a file.
 */
export interface HostConfigStrategy<V = unknown> {
  locate(content: string, selector: string): TextRange | null;
  apply(content: string, selector: string, value: V): FragmentEdit;
  /** The outermost container that an insert at the selector would create in the content; null when there is none. */
  created?(content: string, selector: string): string | null;
}

export interface FragmentRequest<V = unknown> {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  readonly strategy: HostConfigStrategy<V>;
  readonly value: V;
  /** An override, a refresh over a user's change, or a refresh with no recorded fragment applies only with this explicit selection. */
  readonly selected?: boolean;
}

/**
 * A fragment that the plan input did not select: an override, or a refresh
 * over a value that the user changed at the recorded selector.
 */
export interface SkippedOverride {
  readonly code: 'host_config_override_skipped' | 'host_config_user_value_kept';
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
}
