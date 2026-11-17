/**
 * The safety hook (#2916): the agent-layer security bar on the PreToolUse bash and edit routes of Claude, Codex and Pi.
 *
 * - I1: refuse a call that prints or sends a credential store. Secret redaction stays as the second layer.
 * - I2: refuse a removal or overwrite of an existing file outside the agent's worktree, the managed worktree root, the system temp
 *   directory and the host agent's own memory and plan directories, unless rh's install ledger records the file as rh-created.
 *   Creates and appends pass everywhere. The user authorizes anything else locally by running the command in their own shell,
 *   which no hook sees. A writing `find` that follows links below a start (`-L`, `-follow`, `-H` on a link start, or a writing
 *   `-exec` template with `{}/`) makes that start an unknown target.
 * - Recursive delete: refuse `rm -r`, `find -delete`/`-exec` and `git clean -x` from the repository root or an ancestor.
 *
 * The threat model is accidents. A target built at run time, a script or binary that writes, and a hidden alias are accepted
 * residuals; only a removal whose target is not known fails closed.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { managedWorktreeRoot } from '../../effects/git/managed-worktree';
import { containsSecret, hasUnredactedSecret, replaceSecrets } from '../../core/security/secret-patterns';
import type { Denial } from './mutation-guard';
import type { RouteHost } from './route-registry';
import {
  escapePattern, expandBraces, globIndex, segmentMatches, simpleCommands, unescapePattern, writeThroughPath,
  type Command, type Dirs, type Word,
} from './shell-words';

export interface SafetyScope {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly host: RouteHost;
}

/**
 * - `destroy` removes or replaces the entry itself (rm, an mv operand, sed -i): the leaf link is not followed, except through a
 *   trailing separator.
 * - `change` writes content into an existing file (truncate, shred): the kernel follows the leaf link to its referent.
 * - `overwrite` creates or replaces content (a redirect, cp, tee): it follows the leaf link too.
 * `destroy` and `change` act only on an existing file, so an unknown target denies; an unknown `overwrite` target passes unless
 * its literal directory is an existing directory outside the roots, or its word is above an expansion limit. A glob above the
 * match limit whose run-time part is one name in a directory inside a root is judged by that directory's link children.
 */
export type TargetKind = 'destroy' | 'change' | 'overwrite';

/** One write target. `path` is absolute, or null when the shell decides it at run time. */
export interface WriteTarget {
  readonly kind: TargetKind;
  readonly via: string;
  readonly spelled: string;
  readonly path: string | null;
  /** The working directory that a relative unknown target resolves from. */
  readonly from?: string | null;
  /** For an unknown target: the absolute literal directory before the first run-time character, when the word has one. */
  readonly prefix?: string;
  /**
   * The targets are not known and have no bound (a word above an expansion limit, or a find template path that climbs out of its
   * match with `..`): it refuses for every kind, except as `children` allows.
   */
  readonly unbounded?: true;
  /** A find start that find walks through links: every link below it is judged as the kernel resolves it, within the walk bound. */
  readonly followed?: true;
  /**
   * An unbounded glob whose run-time part is one name in a known directory: its matches are the children of `dir` that `name`
   * matches, each with a trailing separator when `separator` is set.
   */
  readonly children?: { readonly dir: string; readonly name: string; readonly separator: boolean };
  /**
   * cp and ln write `<path>/<name>` for each source name when `path` is an existing directory; the directory itself is not
   * written. `names` is null when a source name is not known, and then every existing child can be the target. cp writes
   * through an existing child link (`follow`); ln replaces the child entry. A recursive cp also writes below each child.
   */
  readonly into?: { readonly names: readonly string[] | null; readonly follow: boolean; readonly recursive: boolean };
  /**
   * An mv operand that can be the destination. When it resolves to an existing directory, mv moves the sources into that
   * directory, so a directory outside the roots is refused. With `intoRoot` (the last operand of the plain form), an allowed root
   * itself or a directory below one passes when the destination entry is in a root too.
   */
  readonly destination?: { readonly intoRoot: boolean };
}

const inside = (rel: string) => !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
const atOrBelow = (root: string, path: string) => inside(relative(root, path));

/** One glob segment matches a name; a leading `*`, `?` or `[` does not match a dot name, as in the shell. */
const nameMatches = (part: string, name: string) => (part.startsWith('.') || !name.startsWith('.')) && segmentMatches(part, name);

/** A glob with a trailing separator matches directories only; a path that cannot be checked counts as one. */
function matchesDirectory(path: string): boolean {
  try { return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true; } catch { return true; }
}

// ---------------------------------------------------------------------------
// I2: the decision for one target
// ---------------------------------------------------------------------------

/**
 * The host agent's own output below HOME: the files it writes as memory and plans. `*` is one path segment. The rest of
 * `~/.claude`, `~/.codex` and `~/.pi` (settings, context files, hooks, skills, credentials) stays protected.
 */
const AGENT_OUTPUT: Readonly<Record<RouteHost, readonly string[]>> = {
  claude: ['.claude/projects/*/memory', '.claude/plans'],
  codex: ['.codex/memories'],
  pi: [],
};

/** An allowed root: a canonical directory, with `*` segments for the agent output patterns. */
type Root = readonly string[];

/**
 * The worktree, the managed worktree root (`/tmp` on POSIX unless REPO_HARNESS_WORKTREE_ROOT moves it), the system temp
 * directory and the host's agent output, canonical. A root that does not resolve adds nothing.
 */
function allowedRoots(scope: SafetyScope): Root[] {
  const roots: Root[] = [];
  const candidates: Array<() => string> = [
    () => realpathSync(scope.repoRoot),
    () => managedWorktreeRoot(scope.env),
    () => realpathSync(tmpdir()),
  ];
  for (const candidate of candidates) {
    try { roots.push(segments(candidate())); } catch { /* no allowance for this root */ }
  }
  let home: string;
  try { home = realpathSync(scope.env.HOME ?? homedir()); } catch { return roots; }
  for (const pattern of AGENT_OUTPUT[scope.host]) {
    // The literal part resolves through its links (a linked ~/.claude), so it compares with canonical targets.
    const parts = pattern.split('/');
    const glob = parts.indexOf('*');
    const literal = join(home, ...(glob < 0 ? parts : parts.slice(0, glob)));
    let base: string;
    try { base = writeThroughPath(literal); } catch { continue; }
    roots.push([...segments(base), ...(glob < 0 ? [] : parts.slice(glob))]);
  }
  return roots;
}

const segments = (path: string): string[] => resolve(path).split(sep);

/** The path is strictly below the root, or also at it with `orAt`. */
function underRoot(root: Root, path: string, orAt = false): boolean {
  const parts = segments(path);
  if (parts.length < root.length + (orAt ? 0 : 1)) return false;
  return root.every((part, n) => part === '*' ? parts[n] !== '..' && parts[n] !== '' : parts[n] === part);
}

/** A path separator of this platform at the end; a backslash is a name character on POSIX. */
const TRAILING_SEPARATOR = sep === '/' ? /\/$/ : /[\\/]$/;

/** The entry that rm and mv act on, with every directory above it resolved and trailing separators removed; the leaf link is not followed. */
function leafPath(path: string): string {
  const name = basename(path);
  return name === '' || name === '.' || name === '..' ? writeThroughPath(path) : join(writeThroughPath(dirname(path)), name);
}

/** One surface of rh's install ledger, as the installer records it. */
export interface LedgerSurface {
  readonly path: string;
  readonly type: string;
  readonly managed_marker: string | null;
}

/**
 * The installer owns the ledger reader, and the installer imports the route registry, so the hook process root registers the
 * reader here. Without a reader the ledger records nothing.
 */
let ledgerReader: ((env: NodeJS.ProcessEnv) => readonly LedgerSurface[]) | null = null;

export function registerInstallLedger(reader: (env: NodeJS.ProcessEnv) => readonly LedgerSurface[]): void {
  ledgerReader = reader;
}

/** rh created the file when the install ledger records it, or a directory tree above it, as rh-written. An unreadable ledger records nothing. */
export function ledgerCreated(path: string, env: NodeJS.ProcessEnv): boolean {
  let surfaces: readonly LedgerSurface[];
  try { surfaces = ledgerReader?.(env) ?? []; } catch { return false; }
  return surfaces.some((surface) => {
    let recorded: string;
    try { recorded = leafPath(resolve(surface.path)); } catch { return false; }
    if (surface.type === 'directory-copy') return atOrBelow(recorded, path);
    if (surface.type === 'symlink') return recorded === path;
    // Other managed-file markers name an rh block inside a user file.
    return surface.type === 'managed-file' && surface.managed_marker === 'transaction-created-file' && recorded === path;
  });
}

/** The most children that an unknown copy source name is checked against. */
const CHILD_LIMIT = 1000;

/** The rest of a copy walk's bound, the resolved directories it has listed, and those on the current walk path. */
interface CopyWalk { left: number; readonly seen: Set<string>; readonly active: Set<string> }
/** A directory entry as a listing or a lookup reports it. */
type ChildEntry = Pick<Dirent, 'name' | 'isFile' | 'isDirectory'>;
/** A find that follows links reaches every entry below its start the way a recursive copy that writes through links does. */
const FOLLOWED_WALK = { names: null, follow: true, recursive: true } as const;

class TargetJudge {
  private rootsValue: Root[] | undefined;
  constructor(private readonly scope: SafetyScope, private readonly userStep: string) {}
  private get roots(): Root[] { return this.rootsValue ??= allowedRoots(this.scope); }

  /**
   * The one decision for a literal target and for each glob match. A removal judges the leaf entry, and also the directory that
   * the leaf link resolves to when the operand ends with a separator: the kernel follows the link through the separator, and GNU
   * mv --strip-trailing-slashes removes the separator first. A content write judges the path it writes through.
   */
  denial(target: WriteTarget): Denial | null {
    const needsTarget = target.kind !== 'overwrite';
    if (target.path === null) {
      if (target.children) return this.childrenDenial(target, target.children);
      return needsTarget || target.unbounded ? unknownTargetDenial(target, this.roots, this.userStep) : this.prefixDenial(target);
    }
    if (/^\/dev\//.test(target.path)) return null;
    if (target.followed) {
      // The start entry is judged as any removal operand is; then each link below it.
      return this.denial({ ...target, followed: undefined })
        ?? this.outputDenial(target, FOLLOWED_WALK, target.path, { left: CHILD_LIMIT, seen: new Set(), active: new Set() });
    }
    let paths: string[];
    try {
      paths = target.kind !== 'destroy' ? [writeThroughPath(target.path)]
        : [leafPath(target.path), ...(TRAILING_SEPARATOR.test(target.path) ? [writeThroughPath(target.path)] : [])];
    } catch {
      // A path that does not resolve (a link loop, an unreadable directory) cannot be checked.
      return needsTarget ? unknownTargetDenial(target, this.roots, this.userStep) : null;
    }
    const into = target.destination ? existingDirectory(target.path) : null;
    if (into) {
      const inRoot = (path: string) => this.roots.some(root => underRoot(root, path, true));
      // The directory check only refuses: a ledger-created directory never excuses the entry checks below.
      if (!inRoot(into)) {
        const denial = this.existingDenial(target, into);
        if (denial) return denial;
      } else if (target.destination!.intoRoot && (TRAILING_SEPARATOR.test(target.path) || inRoot(paths[0]!))) {
        // BSD mv -h renames over a destination link to a directory, so the entry itself must be in a root too. No option of the
        // plain form removes a trailing separator, so the kernel follows that link and the directory is the entry.
        return null;
      }
    }
    if (target.into && statSync(paths[0]!, { throwIfNoEntry: false })?.isDirectory()) return this.childDenial(target, target.into, paths[0]!);
    for (const path of paths) {
      const denial = this.existingDenial(target, path);
      if (denial) return denial;
    }
    return null;
  }

  /**
   * An unknown overwrite target with a literal directory: an existing directory outside the roots refuses. The check only
   * refuses; an unknown overwrite target passes otherwise, as a create passes everywhere.
   */
  private prefixDenial(target: WriteTarget): Denial | null {
    if (target.prefix === undefined) return null;
    let dir: string;
    try { dir = writeThroughPath(target.prefix); } catch { return null; }
    if (this.roots.some(root => underRoot(root, dir, true)) || !existsSync(dir) || ledgerCreated(dir, this.scope.env)) return null;
    return outsideDenial(target, dir, this.roots, this.userStep);
  }

  /**
   * A glob above the match limit in one directory. When the directory resolves inside a root, a match that is not a link is a
   * child entry inside the root, for every kind and through a trailing separator, so only the matches that can be links get the
   * one decision. The directory is placed before it is listed; outside the roots the word stays an unknown target set.
   */
  private childrenDenial(target: WriteTarget, children: NonNullable<WriteTarget['children']>): Denial | null {
    const unknown = () => unknownTargetDenial(target, this.roots, this.userStep);
    let dir: string, entries: Dirent[];
    try {
      dir = writeThroughPath(children.dir);
      if (!this.roots.some(root => underRoot(root, dir, true))) return unknown();
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return unknown(); }
    let links = 0;
    for (const entry of entries) {
      // An entry without a reported type is neither a file nor a directory here, so it is judged like a link.
      if (entry.isFile() || entry.isDirectory() || !nameMatches(children.name, entry.name)) continue;
      // The resolved directory holds no link, so joining the name keeps the path the kernel walks.
      const path = join(dir, entry.name) + (children.separator ? sep : '');
      if (children.separator && !matchesDirectory(path)) continue;
      if (++links > CHILD_LIMIT) return unknown();
      const denial = this.denial({ ...target, path, children: undefined, unbounded: undefined });
      if (denial) return denial;
    }
    return null;
  }

  /** A copy into a directory writes one child per source name; without the names, every existing child is a possible target. */
  private childDenial(target: WriteTarget, into: NonNullable<WriteTarget['into']>, dir: string): Denial | null {
    const unknown = () => unknownTargetDenial(target, this.roots, this.userStep);
    const entries: ChildEntry[] = [];
    try {
      if (into.names === null) entries.push(...readdirSync(dir, { withFileTypes: true }));
      // The file system decides which entry a name reaches (a case-insensitive volume maps `report.txt` to `REPORT.txt`), so each
      // known name is looked up, not matched against a listing. A name without an entry is a create.
      for (const name of new Set(into.names)) {
        const stats = lstatSync(join(dir, name), { throwIfNoEntry: false });
        if (stats) entries.push({ name, isFile: () => stats.isFile(), isDirectory: () => stats.isDirectory() });
      }
    } catch { return unknown(); }
    if (into.names === null && entries.length > CHILD_LIMIT) return unknown();
    return this.entriesDenial(target, into, dir, entries, { left: CHILD_LIMIT, seen: new Set(), active: new Set() });
  }

  /**
   * The outputs of a copy at existing entries of a resolved directory. In a directory inside a root, a regular file, and a real
   * directory that the copy does not descend into, is an entry inside the root; only the other entries are judged. Directories
   * listed and links resolved share one bound per target.
   */
  private entriesDenial(target: WriteTarget, into: NonNullable<WriteTarget['into']>, dir: string, entries: readonly ChildEntry[], walk: CopyWalk): Denial | null {
    const inRoot = this.roots.some(root => underRoot(root, dir, true));
    for (const entry of entries) {
      if (inRoot && (entry.isFile() || (entry.isDirectory() && !into.recursive))) continue;
      if (!entry.isFile() && !entry.isDirectory() && --walk.left < 0) return unknownTargetDenial(target, this.roots, this.userStep);
      const denial = this.outputDenial(target, into, join(dir, entry.name), walk);
      if (denial) return denial;
    }
    return null;
  }

  /** One output path of a copy, resolved as the kernel writes it. A recursive copy also writes below an existing directory. */
  private outputDenial(target: WriteTarget, into: NonNullable<WriteTarget['into']>, path: string, walk: CopyWalk): Denial | null {
    const unknown = () => unknownTargetDenial(target, this.roots, this.userStep);
    let output = path;
    try { if (into.follow) output = writeThroughPath(path); } catch { return unknown(); }
    const denial = this.existingDenial(target, output);
    if (denial || !into.recursive || !statSync(output, { throwIfNoEntry: false })?.isDirectory()) return denial;
    // A directory on the current walk path is a cycle that the copy keeps writing through; one listed before is already judged.
    if (walk.active.has(output)) return unknown();
    if (walk.seen.has(output)) return null;
    walk.seen.add(output);
    if (--walk.left < 0) return unknown();
    let entries: Dirent[];
    try { entries = readdirSync(output, { withFileTypes: true }); } catch { return unknown(); }
    walk.active.add(output);
    const below = this.entriesDenial(target, into, output, entries, walk);
    walk.active.delete(output);
    return below;
  }

  private existingDenial(target: WriteTarget, path: string): Denial | null {
    if (this.roots.some(root => underRoot(root, path))) return null;
    const exists = target.kind === 'destroy' ? lstatSync(path, { throwIfNoEntry: false }) !== undefined : existsSync(path);
    if (!exists || ledgerCreated(path, this.scope.env)) return null;
    return outsideDenial(target, path, this.roots, this.userStep);
  }
}

/** The existing directory that the path resolves to through every link, or null. */
function existingDirectory(path: string): string | null {
  try {
    const dir = writeThroughPath(path);
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : null;
  } catch { return null; }
}

const rootList = (roots: readonly Root[]) => roots.map(root => root.join(sep)).join(', ');

function outsideDenial(target: WriteTarget, path: string, roots: readonly Root[], userStep: string): Denial {
  return {
    guard: 'UserFileGuard',
    reason: `I2: ${target.via} would ${target.kind === 'overwrite' ? 'overwrite' : 'remove or change'} ${path}, an existing file outside `
      + `the allowed roots (${rootList(roots)}), and rh's install ledger does not record it as rh-created.`,
    fix: `Work on a copy inside an allowed root, or ${userStep}.`,
    askable: true,
  };
}

function unknownTargetDenial(target: WriteTarget, roots: readonly Root[], userStep: string): Denial {
  return {
    guard: 'UserFileGuard',
    reason: `I2: the target ${target.spelled} of ${target.via}${target.from ? ` from ${target.from}` : ''} is not known before the command runs, `
      + `and ${target.via} ${target.kind === 'overwrite' ? 'overwrites' : 'removes or changes'} an existing file. Allowed roots: ${rootList(roots)}.`,
    fix: `Write the target as a literal path inside an allowed root from a known working directory, or ${userStep}.`,
    askable: true,
  };
}

/** The first I2 denial among the targets. `userStep` says how the user does the call themselves. */
export function writeTargetDenial(targets: readonly WriteTarget[], scope: SafetyScope, userStep: string | ((path: string) => string)): Denial | null {
  // One glob can give many targets, so a fixed user step shares one judge and one root list.
  const shared = typeof userStep === 'string' ? new TargetJudge(scope, userStep) : null;
  for (const target of targets) {
    const judge = typeof userStep === 'string' ? shared! : new TargetJudge(scope, userStep(target.path ?? target.spelled));
    const denial = judge.denial(target);
    if (denial) return denial;
  }
  return null;
}

/**
 * The user runs a one-line command themselves with Claude Code's `!` prefix; a longer command runs in their own shell. A command
 * that holds a secret shows only its redacted form, and none at all when the redaction leaves a secret.
 */
function bashUserStep(command: string): string {
  const line = command.trim();
  const generic = 'the user can run the command themselves in their own shell (Claude Code: `! <command>`)';
  if (line.includes('\n') || line.length > 300) return generic;
  if (!containsSecret(line)) return `the user can run it themselves: \`! ${line}\``;
  const redacted = replaceSecrets(line);
  return hasUnredactedSecret(redacted)
    ? `${generic}; the command holds a secret, so it is not shown`
    : `the user can run it themselves: \`! ${redacted}\` (secrets redacted; put the real values back)`;
}

// ---------------------------------------------------------------------------
// I1: credential stores
// ---------------------------------------------------------------------------

const ENV_FILE = /^\.env(?:$|[.\-_]|rc$)/;
const ENV_TEMPLATE = /\.(?:example|sample|template)$/i;

/** True when a literal path names a credential store: an SSH private key or the .ssh directory, auth.json, *credentials*.json or .env*. */
export function namesCredentialStore(path: string): boolean {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  const name = parts.at(-1) ?? '';
  if (parts.at(-2) === '.ssh') return name.startsWith('id_') && !name.endsWith('.pub');
  return name === '.ssh' || name === 'auth.json' || /credentials.*\.json$/i.test(name)
    || (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name));
}

/** Names a glob is tried against when its directory cannot be listed. */
const SAMPLE_NAMES = ['.env', '.env.local', '.envrc', '.ssh', 'auth.json', 'credentials.json', 'id_rsa', 'id_ed25519'];

/** The entries a glob's literal directory holds, or null when the directory cannot be placed or read. */
function listing(dir: string, dirs: Dirs): string[] | null {
  const expanded = /^~(?:\/|$)/.test(dir) ? homedir() + dir.slice(1) : dir;
  const base = isAbsolute(expanded) ? expanded : dirs && dirs[0] !== undefined ? `${dirs[0]}${sep}${expanded}` : null;
  if (base === null) return null;
  try { return readdirSync(base || '.'); } catch { return null; }
}

/**
 * True when one shell pattern (after brace expansion) reads a credential store. A glob counts when it can match a credential
 * name in its directory: the existing entries when the directory can be listed, otherwise the sample names. A leading `*` does
 * not match a dot file, as in the shell.
 */
function patternReadsCredential(pattern: string, dirs: Dirs): boolean {
  const glob = globIndex(pattern);
  const cut = pattern.lastIndexOf('/') + 1;
  const name = pattern.slice(cut);
  const dir = unescapePattern(pattern.slice(0, cut));
  if (globIndex(name) < 0) return namesCredentialStore(unescapePattern(pattern));
  // A glob in a directory segment cannot be listed; its last segment is tried against the sample names.
  const candidates = (cut <= glob ? listing(dir, dirs) : null) ?? SAMPLE_NAMES;
  return candidates.some(entry => nameMatches(name, entry) && namesCredentialStore(`${dir}${entry}`));
}

/** True when a word, as the program consumes it after quote removal and brace expansion, names a credential store. */
function wordReadsCredential(value: string, pattern: string, dirs: Dirs): boolean {
  if (!value) return false;
  const patterns = expandBraces(pattern) ?? [pattern];
  return patterns.some(item => patternReadsCredential(item, dirs));
}

/**
 * The files that a word sends, by curl's grammar, after brace expansion: `@file` (-d, --data-binary) and the form value
 * `name=@file` or `name=<file` (-F). A form file runs to the first `;`, which starts its parameters (`;type=`, `;filename=`), and
 * may be double-quoted; `@a,b` sends both files. Curl reads the operand as written, without globbing.
 */
function sentFiles(word: Word): string[] {
  return (expandBraces(word.pattern) ?? [word.pattern]).flatMap(pattern => {
    const value = unescapePattern(pattern);
    if (value.startsWith('@')) return [value.slice(1)];
    const form = /=([@<])/.exec(value);
    if (!form) return [];
    const rest = value.slice(form.index + 2);
    const close = rest.indexOf('"', 1);
    const file = rest.startsWith('"') && close > 0 ? rest.slice(1, close) : rest.split(';')[0]!;
    return form[1] === '@' ? file.split(',') : [file];
  });
}

/** Programs that read no file content to their output: their operands stay local. */
const NO_CONTENT = new Set(['ls', 'stat', 'test', '[', 'file', 'chmod', 'chown', 'touch', 'mkdir', 'rm', 'mv', 'cd', 'du', 'realpath',
  'readlink', 'basename', 'dirname', 'source', '.', 'echo', 'printf', 'ssh-add']);
const SSH = new Set(['ssh', 'scp', 'sftp']);
const GREP = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
/** grep options whose separate value is a count, a type or a path filter, never a file it reads. */
const GREP_VALUED = new Set(['-A', '-B', '-C', '-m', '-g', '-t', '-T', '--max-count', '--context', '--after-context', '--before-context',
  '--glob', '--type', '--type-not', '--include', '--exclude', '--exclude-dir']);
/** git subcommands whose path operands only filter or name paths; they print no file content. */
const GIT_PATH_FILTERS = new Set(['status', 'ls-files', 'check-ignore', 'rm', 'mv', 'restore', 'checkout', 'switch', 'log', 'shortlog']);
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice']);
const SUDO_VALUE = new Set(['-u', '-g', '-C', '-h', '-p', '-U']);

/** The index of the program word after leading assignments and wrappers such as sudo or `env NAME=value`; -1 when none runs. */
function programAt(words: readonly Word[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (word.assign) { i++; continue; }
    if (word.value === 'env' && !word.quoted) {
      i++;
      while (i < words.length && (words[i]!.value.startsWith('-') || words[i]!.assign)) i += ['-u', '-C', '-S'].includes(words[i]!.value) ? 2 : 1;
      continue;
    }
    if (!WRAPPERS.has(word.value) || word.quoted) return i;
    i++;
    while (i < words.length && words[i]!.value.startsWith('-')) i += word.value === 'sudo' && SUDO_VALUE.has(words[i]!.value) ? 2 : 1;
  }
  return -1;
}

/**
 * The file operands that a reading program consumes, by its grammar: an option value after `=` counts, a separate word counts
 * unless the program's grammar makes it a pattern, a destination, a path filter or a loaded env or identity file.
 */
function readOperands(program: string, args: readonly Word[]): Array<{ value: string; pattern: string }> {
  const skip = new Set<number>();
  args.forEach((word, n) => {
    const previous = args[n - 1]?.value ?? '';
    // An env file loads into a process, and an ssh identity authenticates; neither is printed or sent.
    if (previous === '--env-file' || word.value.startsWith('--env-file=') || (SSH.has(program) && previous === '-i')) skip.add(n);
  });
  if (GREP.has(program)) {
    let explicit = false;
    args.forEach((word, n) => {
      if (GREP_VALUED.has(word.value)) skip.add(n + 1);
      else if (/^--(?:include|exclude|exclude-dir|glob|type|type-not|max-count|context)=/.test(word.value)) skip.add(n);
      else if (['-e', '--regexp'].includes(word.value) || /^-[a-zA-Z]+e$/.test(word.value)) { explicit = true; skip.add(n + 1); }
      else if (/^-[a-zA-Z]*e./.test(word.value) && !word.value.startsWith('--') || word.value.startsWith('--regexp=')) { explicit = true; skip.add(n); }
      else if (['-f', '--file'].includes(word.value) || word.value.startsWith('--file=')) explicit = true;
    });
    if (!explicit) {
      const pattern = args.findIndex((word, n) => !skip.has(n) && !word.value.startsWith('-'));
      if (pattern >= 0) skip.add(pattern);
    }
  }
  if (program === 'cp') {
    const target = args.findIndex(word => /^-[a-zA-Z]*t$|^--target-directory$/.test(word.value));
    if (target >= 0) skip.add(target + 1);
    else {
      const destination = args.map((word, n) => [word, n] as const).filter(([word]) => !word.value.startsWith('-')).at(-1);
      if (destination) skip.add(destination[1]);
    }
  }
  if (program === 'git') {
    let at = 0;
    while (at < args.length && args[at]!.value.startsWith('-')) at += ['-C', '-c'].includes(args[at]!.value) ? 2 : 1;
    const sub = args[at]?.value ?? '';
    const patch = args.some(word => word.value === '-p' || word.value === '--patch');
    if (GIT_PATH_FILTERS.has(sub) && !(sub === 'log' && patch)) return [];
    for (let n = 0; n <= at && n < args.length; n++) skip.add(n);
    args.forEach((word, n) => { if (['-m', '--message'].includes(word.value)) skip.add(n + 1); });
  }
  const operands: Array<{ value: string; pattern: string }> = [];
  args.forEach((word, n) => {
    if (skip.has(n)) return;
    if (!word.value.startsWith('-')) operands.push({ value: word.value, pattern: word.pattern });
    else if (word.value.includes('=')) {
      const at = word.value.indexOf('=') + 1;
      operands.push({ value: word.value.slice(at), pattern: word.pattern.slice(word.pattern.indexOf('=') + 1) });
    }
  });
  return operands;
}

function credentialDenial(reason: string): Denial {
  return {
    guard: 'CredentialGuard',
    reason: `I1: ${reason}; its output can reach the model, a log or a remote.`,
    fix: 'Do not print or send credential stores. Use the tool that owns the secret without printing it, or ask the user to run the command in their own shell (Claude Code: `! <command>`).',
  };
}

/** The I1 denial for one simple command, or null. */
function credentialFinding(cmd: Command, dirs: Dirs): Denial | null {
  for (const redirect of cmd.redirects) {
    const target = redirect.target;
    if (redirect.op.replace(/^\d+/, '') === '<' && target && wordReadsCredential(target.value, target.pattern, dirs)) {
      return credentialDenial(`the command reads the credential store ${target.value} from a redirect`);
    }
  }
  const words = cmd.words;
  const at = programAt(words);
  if (at < 0) {
    return words.some(word => word.value === 'env' && !word.quoted) ? credentialDenial('env prints the whole environment') : null;
  }
  const program = words[at]!.value;
  const args = words.slice(at + 1);
  if (program === 'printenv' && args.every(word => word.value.startsWith('-'))) return credentialDenial('printenv prints the whole environment');
  if (program === 'security') {
    const sub = args[0]?.value ?? '';
    if (sub === 'dump-keychain') return credentialDenial('security dump-keychain prints the keychain');
    if (/^find-(?:generic|internet)-password$/.test(sub) && args.some(word => /^-[a-zA-Z]*[wg]/.test(word.value))) {
      return credentialDenial(`security ${sub} -w or -g prints a keychain password`);
    }
  }
  if (NO_CONTENT.has(program)) return null;
  for (const word of args) {
    const sent = sentFiles(word).find(file => wordReadsCredential(file, escapePattern(file), dirs));
    if (sent !== undefined) return credentialDenial(`${program} sends the credential store ${sent}`);
  }
  const named = readOperands(program, args).find(operand => wordReadsCredential(operand.value, operand.pattern, dirs));
  return named ? credentialDenial(`${program} reads the credential store ${named.value}`) : null;
}

// ---------------------------------------------------------------------------
// I2: the write targets of one Bash command
// ---------------------------------------------------------------------------

/**
 * One word that the program receives after the shell expands a command word. `value` is null when the shell decides it at run
 * time. `pattern` is the word after brace and HOME expansion and before glob expansion, so the program grammar can still read an
 * option or `of=` prefix and the literal directory of an unknown word. `matched` marks a glob match, and `word` is the index of
 * the command word that produced it.
 */
interface Arg {
  readonly value: string | null;
  readonly pattern: string;
  readonly expand: boolean;
  readonly spelled: string;
  readonly word: number;
  readonly matched: boolean;
  /** The word is above the brace limit or a glob above the match limit. */
  readonly unbounded?: true;
}

/** The text that the grammar reads: the value, or the word as written when the shell decides it at run time. */
const text = (arg: Arg) => arg.value ?? unescapePattern(arg.pattern);

/** The first unescaped character of `chars` in a pattern, or -1. */
function patternIndex(pattern: string, chars: string): number {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if (chars.includes(pattern[i]!)) return i;
  }
  return -1;
}

/** The literal directory before the first run-time character of a pattern, or null when the word has none. */
function literalDirectory(pattern: string): string | null {
  if (pattern.startsWith('~')) return null;
  const stop = patternIndex(pattern, '$*?[{');
  return unescapePattern(pattern.slice(0, pattern.lastIndexOf('/', stop < 0 ? pattern.length : stop) + 1)) || null;
}

/**
 * One brace item before glob expansion: a leading `~`, `$HOME` or `${HOME}` is HOME and `~+` is the working directory. The
 * item's own text decides whether it is known. In a word that changes at run time, an item with a `$` (a parameter or a
 * substitution) is unknown, and so is an item with a backslash, because the reader keeps a `$'...'` escape undecoded. An item
 * with `~user` is unknown too.
 */
function itemArg(pattern: string, expand: boolean, at: number, home: string): Arg {
  const lead = /^(?:~|\$HOME|\$\\\{HOME\\\})(?=\/|$)/.exec(pattern);
  if (lead) pattern = escapePattern(home) + pattern.slice(lead[0].length);
  else if (/^~\+(?:\/|$)/.test(pattern)) pattern = `.${pattern.slice(2)}`;
  const value = unescapePattern(pattern);
  const known = !pattern.startsWith('~') && !(expand && (pattern.includes('$') || value.includes('\\')));
  return { value: known ? value : null, pattern, expand, spelled: value, word: at, matched: false };
}

const NUMERIC_SEQUENCE = /^\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\}/;
/** The mark of a collapsed sequence in a shaped word. A shell word never holds a NUL. */
const SEQUENCE_MARK = '\0';

/** The word with each numeric `{a..b}` sequence as one mark, or null when it has none or holds a bracket. The comma items keep their text. */
function sequenceShape(pattern: string): string | null {
  if (patternIndex(pattern, '[') >= 0) return null;
  let shape = '', found = false;
  for (let i = 0; i < pattern.length; i++) {
    const sequence = pattern[i] === '{' ? NUMERIC_SEQUENCE.exec(pattern.slice(i)) : null;
    if (pattern[i] === '\\') { shape += pattern.slice(i, i + 2); i++; }
    else if (sequence) { shape += SEQUENCE_MARK; i += sequence[0].length - 1; found = true; } else shape += pattern[i];
  }
  return found ? shape : null;
}

/** A word or item above an expansion limit: an unknown target set that refuses for every kind. */
const unbounded = (arg: Arg): Arg => ({ ...arg, value: null, unbounded: true });

/**
 * The words that one command word gives the program, as the shell expands it without running anything: brace expansion, HOME,
 * then glob expansion from `cwd`. Expansion never drops an operand: each brace item gives its own words, and an item that is not
 * known gives one unknown word. Above the brace limit each numeric sequence collapses, and an item that holds one is an unbounded word
 * whose sequence is `*`; when the word is still above the limit, the whole word is one unbounded word. A glob item above the
 * match limit is one unbounded word too.
 */
function expandWord(word: Word, at: number, cwd: string | null, home: string, targetRole = true): Arg[] {
  const exact = expandBraces(word.pattern);
  const shape = exact === null && targetRole ? sequenceShape(word.pattern) : null;
  const patterns = exact ?? (shape === null ? null : expandBraces(shape));
  if (patterns === null) return [unbounded(itemArg(word.pattern, word.expand, at, home))];
  let budget = CHILD_LIMIT;
  return patterns.flatMap(item => {
    // A numeric item holds digits and a sign only, never a separator or a leading dot, so `*` matches every existing entry that an
    // item names. The item is not globbed: the shell passes each number as written, also after a prefix such as `of=`.
    if (item.includes(SEQUENCE_MARK)) {
      return [{ ...unbounded(itemArg(item.replaceAll(SEQUENCE_MARK, '*'), word.expand, at, home)), spelled: unescapePattern(word.pattern) }];
    }
    const arg = itemArg(item, word.expand, at, home);
    if (arg.value === null || globIndex(arg.pattern) < 0) return [arg];
    const matches = globMatches(arg.pattern, cwd, budget);
    if (matches === null) return [unbounded(arg)];
    budget -= matches.length;
    // Without a match the shell passes the word itself.
    return matches.length
      ? matches.map(value => ({ value, pattern: escapePattern(value), expand: false, spelled: value, word: at, matched: true }))
      : [arg];
  });
}

/**
 * The part of a word after a prefix of `length` characters (`of=`, `--target-directory=`, `-t`), resolved as its own brace item:
 * HOME is substituted again, and an unknown rest keeps its literal directory. The shell globs the whole word, so the rest is not
 * globbed again.
 */
function restArg(arg: Arg, length: number, home: string): Arg {
  let at = 0;
  for (let count = 0; count < length && at < arg.pattern.length; count++) at += arg.pattern[at] === '\\' ? 2 : 1;
  const rest = itemArg(arg.pattern.slice(at), arg.expand, arg.word, home);
  // A part of a word that is not known before the command runs is not known either.
  return arg.unbounded ? unbounded(rest) : arg.value === null ? { ...rest, value: null } : rest;
}

/**
 * The paths that a glob pattern matches from `cwd`, one segment at a time, in the spelling the shell passes (`..` and links
 * stay for the judge). A leading `*`, `?` or `[` does not match a dot name. A trailing separator matches directories only and
 * stays on each match. Null when the pattern cannot be expanded: a relative pattern without a known directory, a listing error
 * other than a missing directory, or more matches than `limit`.
 */
function globMatches(pattern: string, cwd: string | null, limit: number): string[] | null {
  if (!isAbsolute(pattern) && cwd === null) return null;
  const absolute = (path: string) => isAbsolute(path) ? path : `${cwd}${sep}${path || '.'}`;
  const parts = pattern.split('/');
  let found = [''];
  for (let n = 0; n < parts.length; n++) {
    const part = parts[n]!;
    const extend = (prefix: string, name: string) => n === 0 ? name : `${prefix}/${name}`;
    if (globIndex(part) < 0) { found = found.map(prefix => extend(prefix, unescapePattern(part))); continue; }
    const next: string[] = [];
    for (const prefix of found) {
      let names: string[];
      try { names = readdirSync(absolute(n > 0 && prefix === '' ? '/' : prefix)); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        return null;
      }
      for (const name of names.sort()) {
        if (nameMatches(part, name)) next.push(extend(prefix, name));
      }
      if (next.length > limit) return null;
    }
    found = next;
  }
  const directoriesOnly = parts.length > 1 && parts.at(-1) === '';
  return found.filter(path => {
    if (directoriesOnly) return matchesDirectory(absolute(path));
    try { return lstatSync(absolute(path), { throwIfNoEntry: false }) !== undefined; } catch { return true; }
  });
}

/** The arguments after the program word, expanded from one working directory. */
const expandArgs = (words: readonly Word[], cwd: string | null, home: string, targetRole: boolean): Arg[] =>
  words.flatMap((word, at) => expandWord(word, at, cwd, home, targetRole));

const literalArg = (value: string): Arg => ({ value, pattern: escapePattern(value), expand: false, spelled: value, word: -1, matched: false });

function targetOf(kind: TargetKind, via: string, arg: Arg, cwd: string | null, extra: Pick<WriteTarget, 'into' | 'destination'> = {}): WriteTarget {
  const resolveFrom = (value: string) => isAbsolute(value) ? value : cwd === null ? null : `${cwd}${sep}${value}`;
  // The path keeps its `..` parts: the kernel follows each link before the `..` after it.
  const path = arg.value === null ? null : resolveFrom(arg.value || '.');
  const dir = arg.value === null ? literalDirectory(arg.pattern) : null;
  const prefix = dir === null ? null : resolveFrom(dir);
  const children = arg.unbounded ? childGlob(arg.pattern, resolveFrom) : null;
  return {
    kind, via, spelled: arg.spelled, path, from: cwd, ...(prefix === null ? {} : { prefix }),
    ...(arg.unbounded ? { unbounded: true as const } : {}), ...(children ? { children } : {}), ...extra,
  };
}

/**
 * The literal directory and the name pattern of a glob whose glob characters are all in its last segment, which a trailing
 * separator may follow; null otherwise. A glob character never matches a separator, but a brace left in the pattern can hold one.
 */
function childGlob(pattern: string, resolveFrom: (value: string) => string | null): WriteTarget['children'] | null {
  const separator = pattern.endsWith('/');
  const body = separator ? pattern.slice(0, -1) : pattern;
  const cut = body.lastIndexOf('/') + 1;
  const name = body.slice(cut);
  if (globIndex(name) < 0 || globIndex(body.slice(0, cut)) >= 0 || patternIndex(body, '{') >= 0) return null;
  const dir = resolveFrom(unescapePattern(body.slice(0, cut)) || '.');
  return dir === null ? null : { dir, name, separator };
}

const isOption = (arg: Arg) => text(arg).startsWith('-') && text(arg) !== '-';

/** Operands after options; `valued` options take the next word unless glued (`-tDIR`, `--suffix=x`). */
function operandsOf(args: readonly Arg[], valued: ReadonlySet<string>): Arg[] {
  const operands: Arg[] = [];
  let only = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (only || !isOption(arg)) { operands.push(arg); continue; }
    if (arg.value === '--') { only = true; continue; }
    if (valued.has(text(arg))) i++;
  }
  return operands;
}

const MOVE_VALUED = new Set(['-S', '--suffix']);

/**
 * A target-directory option (`-t`, `-T`, `--target-directory`, `--no-target-directory`, also inside combined short options, and
 * any long prefix that GNU getopt accepts, such as `--target`) changes which operand is the destination. Its glued value
 * (`-tDIR`, `--target-directory=DIR`) is an operand.
 */
function targetOption(arg: Arg, home: string): Arg[] | null {
  const short = /^-(?!-)[a-zA-Z]*?([tT])(.*)$/.exec(text(arg));
  const long = /^--(?:no-)?([a-z-]+)(?:=(.*))?$/.exec(text(arg));
  if (!short && !(long && 'target-directory'.startsWith(long[1]!))) return null;
  const value = short ? (short[1] === 't' ? short[2]! : '') : long![2] ?? '';
  return value ? [restArg(arg, text(arg).length - value.length, home)] : [];
}

/**
 * The value of each target-directory option: the glued value, or else the next word, a dash-prefixed one too, because getopt takes
 * that word as the value. Null when no word is a target-directory option.
 */
function targetValues(args: readonly Arg[], home: string): Arg[] | null {
  let found = false;
  const values = args.flatMap((arg, n) => {
    const glued = targetOption(arg, home);
    if (glued === null) return [];
    found = true;
    return glued.length > 0 ? glued : args.slice(n + 1, n + 2);
  });
  return found ? values : null;
}

/**
 * cp and ln: the last operand is the destination, written into a directory as each source's name. When the hook cannot place the
 * destination (a target-directory option, fewer than two operands, or a last operand from a glob with several matches, whose
 * order depends on the shell's locale), every operand is a possible write target, and also a possible directory that receives
 * every other operand's name.
 */
function copyTargets(program: string, args: readonly Arg[], cwd: string | null, home: string): WriteTarget[] {
  const values = targetValues(args, home);
  const operands = operandsOf(args, MOVE_VALUED);
  const last = operands.at(-1);
  const recursive = program === 'cp' && args.some(arg => isOption(arg) && /^-[a-zA-Z]*[rRa]|^--(?:rec|ar)/.test(text(arg)));
  // GNU -T copies a source's contents to the destination; so do a source ending in `.` or `..`, and for BSD cp -R a source with a
  // trailing separator. The written names are then the source's children: every existing child of the destination is a possible output.
  const contents = args.some(arg => isOption(arg) && /^-(?!-)[a-zA-Z]*?T|^--no-t/.test(text(arg)));
  const namesOf = (sources: readonly Arg[]) => {
    const names = sources.map(arg => arg.value === null || (recursive && TRAILING_SEPARATOR.test(arg.value)) ? null : basename(arg.value));
    return contents || names.some(name => name === null || name === '.' || name === '..') ? null : names as string[];
  };
  const unplaced = last !== undefined && last.matched && operands.filter(arg => arg.word === last.word).length > 1;
  if (values !== null || operands.length < 2 || unplaced) {
    const all = [...new Set([...operands, ...values ?? []])];
    const into = { names: namesOf(all), follow: program === 'cp', recursive };
    return all.flatMap(arg => [targetOf('overwrite', program, arg, cwd), targetOf('overwrite', program, arg, cwd, { into })]);
  }
  return [targetOf('overwrite', program, last!, cwd, { into: { names: namesOf(operands.slice(0, -1)), follow: program === 'cp', recursive } })];
}

/**
 * mv removes or replaces each operand. BSD mv stops option parsing at the first operand, so each later word, a dash-prefixed one
 * or `--` too, is an operand. Only the plain form `mv [short flags] src... dest`, without a dash-prefixed word after the first
 * operand, without -t, -T or -S and without a glob, brace or unknown word, names the same destination for BSD and GNU mv: its
 * last operand may move the sources into an allowed root. In every other form, each operand and each target-directory value, a
 * separate dash-prefixed one too, can be the destination.
 */
function moveTargets(words: readonly Word[], args: readonly Arg[], cwd: string | null, home: string): WriteTarget[] {
  const operands = moveOperands(args);
  const first = args.findIndex(arg => !isOption(arg));
  const plain = first >= 0 && args.length - first >= 2 && words.every(word => !word.glob) && args.every(arg => arg.value !== null)
    && args.slice(0, first).every(arg => /^-[a-zA-Z]+$/.test(arg.value!) && !/[tTS]/.test(arg.value!))
    && args.slice(first).every(arg => !isOption(arg));
  if (plain) {
    return operands.map((arg, n) => targetOf('destroy', 'mv', arg, cwd, n === operands.length - 1 ? { destination: { intoRoot: true } } : {}));
  }
  return [...new Set([...operands, ...targetValues(args, home) ?? []])].map(arg => targetOf('destroy', 'mv', arg, cwd, { destination: { intoRoot: false } }));
}

/** The words from the first mv operand on: leading options and a leading `--` are skipped. */
function moveOperands(args: readonly Arg[]): Arg[] {
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.value === '--') return args.slice(i + 1);
    if (!isOption(args[i]!)) return args.slice(i);
  }
  return [];
}

/** Python and Node one-liners: literal file writes and removals in the script text. The interpreter expands no pattern. */
function scriptTargets(program: string, source: string, cwd: string | null): WriteTarget[] {
  const found: Array<[TargetKind, string]> = [];
  const add = (kind: TargetKind, pattern: RegExp, group: number) => {
    for (const match of source.matchAll(pattern)) found.push([kind, match[group]!]);
  };
  if (/^python(?:3(?:\.\d+)?)?$/.test(program)) {
    add('overwrite', /\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?(['"])[^'"\n]*w[^'"\n]*\3/g, 2);
    add('overwrite', /\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.(?:write_text|write_bytes)\s*\(/g, 2);
    add('destroy', /\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.(?:unlink|rmdir)\s*\(/g, 2);
    add('destroy', /\bos\.(?:remove|unlink)\(\s*(['"])([^'"\n]+)\1/g, 2);
  } else {
    add('overwrite', /\bwriteFile(?:Sync)?\(\s*(['"])([^'"\n]+)\1/g, 2);
    add('destroy', /\b(?:unlink|rm)(?:Sync)?\(\s*(['"])([^'"\n]+)\1/g, 2);
  }
  return found.map(([kind, path]) => targetOf(kind, program, literalArg(path), cwd));
}

const FIND_RUNS = /^-(?:exec|execdir|ok|okdir)$/;
const FIND_EXEC_READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ls', 'stat', 'file', 'du', 'diff', 'cmp', 'cut', 'tr', 'jq',
  'echo', 'printf', 'test', 'basename', 'dirname', 'realpath', 'readlink', 'sort']);

type Valued = { readonly value: string | null };

type Count = number | null;
const both = (n: number): readonly [Count, Count, Count] => [n, n, n];
const gnuOnly = (n: number): readonly [Count, Count, Count] => [n, null, null];
const bsdOnly = (n: number): readonly [Count, Count, Count] => [null, n, n];
const entries = (names: string, count: readonly [Count, Count, Count]) => names.split(' ').map(name => [name, count] as const);

/**
 * The operands of each find primary and operator: [GNU findutils manual, macOS find(1) fewest, macOS find(1) most]; null where that
 * find has no such word. macOS `-depth` stands alone or takes `n`. The `-exec` family takes a template instead.
 */
const FIND_PRIMARIES: ReadonlyMap<string, readonly [Count, Count, Count]> = new Map([
  ...entries('-delete -empty -false -true -ls -print -print0 -prune -quit -nogroup -nouser -not -and -or ! ( ) -follow -xdev -mount -noleaf -d -ignore_readdir_race -noignore_readdir_race', both(0)),
  ...entries('-amin -anewer -atime -cmin -cnewer -ctime -fstype -gid -group -ilname -iname -inum -ipath -iregex -iwholename -links -lname -maxdepth -mindepth -mmin -mtime -name -newer -path -perm -regex -samefile -size -type -uid -user -wholename', both(1)),
  ['-depth', [0, 0, 1]],
  ...entries('-a -o , -daystart -warn -nowarn -executable -readable -writable -help -version', gnuOnly(0)),
  ...entries('-regextype -files0-from -context -used -xtype -fls -fprint -fprint0 -printf', gnuOnly(1)),
  ['-fprintf', gnuOnly(2)],
  ...entries('-acl -sparse -xattr', bsdOnly(0)),
  ...entries('-Bmin -Bnewer -Btime -flags -mnewer -xattrname', bsdOnly(1)),
]);

/** GNU actions whose first operand is a file that find truncates and writes. */
const FIND_OUTPUTS = new Set(['-fprint', '-fprint0', '-fls', '-fprintf']);

/** GNU options that may stand before a start, as `find -xdev build`; the user means them for the starts after them. */
const FIND_GLOBAL = new Set(['-xdev', '-mount', '-depth', '-d', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race', '-daystart',
  '-follow', '-warn', '-nowarn', '-maxdepth', '-mindepth', '-regextype', '-files0-from', '-help', '-version']);

/** The three readings of the table: GNU, macOS with the fewest operands, macOS with the most. */
type Reading = 0 | 1 | 2;

/**
 * The operands that a word takes in one reading, or null when no find knows the word. A word that one find lacks takes the other
 * find's count: the find that lacks it stops with an error.
 */
function findOperands(value: string, reading: Reading): number | null {
  const counts = FIND_PRIMARIES.get(value) ?? (/^-newer[aBcmt]{2}$/.test(value) ? both(1) : undefined);
  if (!counts) return null;
  return counts[reading] ?? counts.find(count => count !== null)!;
}

/** One find command line: its start paths, the link mode that applies, and what its expression does. */
interface FindCommand<T> {
  readonly starts: T[];
  /** A reading names no start, so find starts from the working directory. */
  readonly currentDirectory: boolean;
  /** The last of -H, -L and -P among the leading options. */
  readonly mode: string;
  /** `-follow` stands as an option or a primary, not as an operand. */
  readonly follow: boolean;
  /** find deletes, or runs a program that is not a reader. */
  readonly writes: boolean;
  /** A writing `-exec` template passes `{}` with a separator after it, so the program walks through a matched link. */
  readonly templateFollows: boolean;
  /** A word that starts with `-` and is no known primary or operator, or `-files0-from`, whose starts come from a file. */
  readonly unknown: T | null;
  /** The file that each `-fprint`, `-fprint0`, `-fls` or `-fprintf` truncates and writes, with its primary. */
  readonly outputs: ReadonlyArray<{ readonly primary: string; readonly file: T }>;
  /** The words of each `-exec` family template; `-execdir` and `-okdir` run it from the directory of each match. */
  readonly templates: ReadonlyArray<{ readonly inMatchDirectory: boolean; readonly words: readonly T[] }>;
}

/**
 * The one find option parser. Leading options run up to `--` or the first other word: BSD getopt clusters of `EHLPXdsx` that may
 * end with `f`, whose start path is the next word, and GNU `-D <opts>` and `-O<n>`. A path glued to `-f` is never read: that word is
 * no cluster, so it is an unknown target. The rest is read once for each table reading, and the result joins every reading, so a
 * write that one reading reaches counts.
 */
function parseFind<T extends Valued>(args: readonly T[]): FindCommand<T> {
  const leading: T[] = [];
  let mode = 'P', i = 0;
  for (; i < args.length; i++) {
    const value = args[i]!.value ?? '';
    if (value === '--') { i++; break; }
    if (/^-O\d$/.test(value)) continue;
    if (value === '-D') { i++; continue; }
    const cluster = /^-([EHLPXdsx]*)(f?)$/.exec(value);
    if (!cluster || value === '-') break;
    mode = cluster[1]!.replace(/[^HLP]/g, '').at(-1) ?? mode;
    if (cluster[2] && args[i + 1]) leading.push(args[++i]!);
  }
  const readings = ([0, 1, 2] as const).map(reading => readFindExpression(args, i, reading));
  return {
    starts: [...new Set([...leading, ...readings.flatMap(found => found.starts)])],
    currentDirectory: leading.length === 0 && readings.some(found => found.starts.length === 0),
    mode,
    follow: readings.some(found => found.follow),
    writes: readings.some(found => found.writes),
    templateFollows: readings.some(found => found.templateFollows),
    unknown: readings.find(found => found.unknown)?.unknown ?? null,
    outputs: [...new Map(readings.flatMap(found => found.outputs).map(output => [output.file, output])).values()],
    templates: [...new Map(readings.flatMap(found => found.templates).map(template => [template.words[0], template])).values()],
  };
}

/**
 * The starts and the expression from `from` in one reading. The starts run to the first word that starts with `-`, `(`, `!` or
 * `)`; a GNU global option before a start is skipped with its operands. In the expression an operand is never a primary, and an
 * `-exec` template runs to `;`, or to `+` after `{}`. A word that no find knows there is an unknown target.
 */
function readFindExpression<T extends Valued>(args: readonly T[], from: number, reading: Reading): Omit<FindCommand<T>, 'mode' | 'currentDirectory'> {
  const starts: T[] = [];
  let follow = false, writes = false, templateFollows = false, expression = false;
  let unknown: T | null = null;
  const outputs: Array<{ primary: string; file: T }> = [];
  const templates: Array<{ inMatchDirectory: boolean; words: T[] }> = [];
  for (let i = from; i < args.length; i++) {
    const value = args[i]!.value ?? '';
    if (!expression && !/^[-(!)]/.test(value)) { starts.push(args[i]!); continue; }
    const operands = findOperands(value, reading);
    if (operands === null && !FIND_RUNS.test(value)) { unknown ??= args[i]!; expression = true; continue; }
    if (!FIND_GLOBAL.has(value)) expression = true;
    if (value === '-files0-from') unknown ??= args[i]!;
    if (FIND_OUTPUTS.has(value) && args[i + 1]) outputs.push({ primary: value, file: args[i + 1]! });
    if (value === '-delete') writes = true;
    else if (value === '-follow') follow = true;
    else if (FIND_RUNS.test(value)) {
      const template: T[] = [];
      for (i++; i < args.length && args[i]!.value !== ';' && !(args[i]!.value === '+' && template.at(-1)?.value === '{}'); i++) template.push(args[i]!);
      if (template.length) templates.push({ inMatchDirectory: value.endsWith('dir'), words: template });
      if (FIND_EXEC_READERS.has(template[0]?.value ?? '')) continue;
      writes = true;
      templateFollows ||= template.slice(1).some(word => /\{\}[\\/]/.test(word.value ?? ''));
    }
    i += operands ?? 0;
  }
  return { starts, follow, writes, templateFollows, unknown, outputs, templates };
}

/**
 * Which starts find follows links from: every start in -L mode, with -follow or with a writing template that passes `{}/` (or
 * writes content to `{}`, judged by the caller), and a start that is a link in -H mode. A writing find then reaches files below a
 * link that its start path does not name, so each link below the start is judged. A start that cannot be checked counts as a link.
 */
function findFollowsLinks(find: FindCommand<Arg>, cwd: string | null): (start: Arg) => boolean {
  if (find.mode === 'L' || find.follow || find.templateFollows) return () => true;
  if (find.mode !== 'H') return () => false;
  return (start) => {
    if (start.value === null || (!isAbsolute(start.value) && cwd === null)) return false;
    // The raw path keeps its `..` parts: the kernel follows a link parent before the `..` after it.
    const path = isAbsolute(start.value) ? start.value : `${cwd}${sep}${start.value}`;
    try {
      return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    } catch { return true; }
  };
}

const DOT: Word = { kind: 'word', value: '.', pattern: '.', expand: false, glob: false, quoted: false, assign: false };
const TRUNCATE_VALUED = new Set(['-s', '--size', '-r', '--reference']);
const SHRED_VALUED = new Set(['-n', '--iterations', '-s', '--size', '--random-source']);
const SED_VALUED = new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']);
const WRITERS = new Set(['rm', 'unlink', 'shred', 'truncate', 'mv', 'cp', 'ln', 'tee', 'sed', 'dd', 'find']);

/**
 * A copy, link or move operand can be a destination that receives other files, so its words keep main's expansion: no sequence
 * shaping, and a word above an expansion limit keeps the unknown-target refusal. Only a word whose matches are themselves the
 * targets is shaped and judged by its directory.
 */
const DESTINATION_ROLE = new Set(['cp', 'ln', 'mv']);
const destinationRole = (target: WriteTarget): WriteTarget => ({ ...target, children: undefined });

/**
 * The write targets of one simple command, run from `cwd` (null when it is not known); every word is expanded first. In a find
 * template (`template`), find puts each match in place of `{}`, so a word that holds `{}` is not known before the command runs.
 */
function commandTargets(cmd: Command, cwd: string | null, home: string, template = false): WriteTarget[] {
  const targets: WriteTarget[] = [];
  for (const redirect of cmd.redirects) {
    const op = redirect.op.replace(/^\d+/, '');
    const target = redirect.target;
    if (!target || !['>', '>|', '&>', '>&'].includes(op)) continue;
    // Descriptor duplication or closure, such as 2>&1, has no file.
    if (op === '>&' && /^(?:\d+|-)$/.test(target.value) && !target.quoted) continue;
    targets.push(...expandWord(target, 0, cwd, home).map(arg => targetOf('overwrite', 'a redirect', arg, cwd)));
  }
  const words = cmd.words;
  const at = programAt(words);
  if (at < 0 || words[at]!.quoted) return targets;
  const program = words[at]!.value;
  const raw = words.slice(at + 1);
  if (/^python(?:3(?:\.\d+)?)?$/.test(program) || program === 'node') {
    const flag = raw.findIndex(word => ['-c', '-e', '--eval'].includes(word.value));
    const heredoc = cmd.redirects.find(redirect => redirect.body !== undefined)?.body ?? '';
    return [...targets, ...scriptTargets(program, flag >= 0 ? raw[flag + 1]?.value ?? '' : heredoc, cwd)];
  }
  // Only a writing program lists directories for its glob words.
  if (!WRITERS.has(program)) return targets;
  const args = expandArgs(raw, cwd, home, !DESTINATION_ROLE.has(program)).map(arg => {
    const word = raw[arg.word]!.value;
    return template && word.includes('{}') ? { ...arg, value: null } : arg;
  });
  const each = (kind: TargetKind, list: readonly Arg[]) => list.map(arg => targetOf(kind, program, arg, cwd));
  switch (program) {
    case 'rm': case 'unlink':
      targets.push(...each('destroy', operandsOf(args, new Set())));
      break;
    case 'shred': {
      const removes = args.some(arg => /^-[a-zA-Z]*u/.test(text(arg)) || /^--remove(?:=|$)/.test(text(arg)));
      for (const arg of operandsOf(args, SHRED_VALUED)) targets.push(...each('change', [arg]), ...(removes ? each('destroy', [arg]) : []));
      break;
    }
    case 'truncate':
      targets.push(...each('change', operandsOf(args, TRUNCATE_VALUED)));
      break;
    case 'mv':
      targets.push(...moveTargets(raw, args, cwd, home).map(destinationRole));
      break;
    case 'cp':
      targets.push(...copyTargets(program, args, cwd, home).map(destinationRole));
      break;
    case 'ln':
      // Without -f, ln refuses an existing destination.
      if (args.some(arg => /^-[a-zA-Z]*f/.test(text(arg)) || arg.value === '--force')) targets.push(...copyTargets(program, args, cwd, home).map(destinationRole));
      break;
    case 'tee':
      if (!args.some(arg => /^-[a-zA-Z]*a/.test(text(arg)) || arg.value === '--append')) targets.push(...each('overwrite', operandsOf(args, new Set())));
      break;
    case 'sed': {
      const inPlace = args.findIndex(arg => /^-i/.test(text(arg)) || /^--in-place(?:=|$)/.test(text(arg)));
      if (inPlace < 0) break;
      // BSD sed takes the backup suffix as the next word: `sed -i '' s/a/b/ file`.
      const list = args.filter((arg, n) => !(n === inPlace + 1 && args[inPlace]!.value === '-i' && arg.value === ''));
      let files = operandsOf(list, SED_VALUED);
      if (!list.some(arg => SED_VALUED.has(text(arg)) || /^--(?:expression|file)=/.test(text(arg)))) files = files.slice(1);
      targets.push(...each('destroy', files));
      break;
    }
    case 'dd':
      // dd reads `of=FILE` from the whole word, so an unknown output keeps its literal directory.
      targets.push(...each('overwrite', args.filter(arg => text(arg).startsWith('of=')).map(arg => restArg(arg, 3, home))));
      break;
    case 'find': {
      const find = parseFind(args);
      // An output file is written whether or not find removes anything, and is judged as a redirect target.
      targets.push(...find.outputs.map(output => targetOf('overwrite', `find ${output.primary}`, output.file, cwd)));
      if (!find.writes) break;
      // Each template is a simple command of its own, judged by the same rules; its `{}` paths are judged through the starts.
      const run = find.templates.flatMap(({ inMatchDirectory, words: [first, ...rest] }) =>
        commandTargets({ ...cmd, words: raw.slice(first!.word, (rest.at(-1) ?? first!).word + 1), redirects: [] }, inMatchDirectory ? null : cwd, home, true));
      // A path that starts with `{}` is below a start, so the starts judge it, unless a `..` part climbs out of the match. A content
      // write to it follows a matched link to its referent, as a walk that follows links reaches it.
      const fromMatch = (target: WriteTarget) => target.path === null && target.spelled.startsWith('{}');
      const climbs = (target: WriteTarget) => /(?:^|\/)\.\.(?:\/|$)/.test(target.spelled.slice(2));
      const found = (target: WriteTarget) => fromMatch(target) && !climbs(target);
      const follows = run.some(target => found(target) && target.kind !== 'destroy') ? () => true : findFollowsLinks(find, cwd);
      targets.push(...[...find.starts, ...(find.currentDirectory ? [literalArg('.')] : [])].map(arg => follows(arg)
        ? { ...targetOf('destroy', 'find following links', arg, cwd), followed: true as const } : targetOf('destroy', 'find', arg, cwd)));
      if (find.unknown) targets.push(targetOf('destroy', 'find', { ...find.unknown, value: null }, cwd));
      targets.push(...run.filter(target => !found(target)).map(target => fromMatch(target) ? { ...target, unbounded: true as const } : target));
      break;
    }
  }
  return targets;
}


// ---------------------------------------------------------------------------
// Recursive delete
// ---------------------------------------------------------------------------

const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs']);

/** Global git options before the subcommand, the `-C` directories in order, and the subcommand index; null for another option. */
function gitInvocation(args: readonly Word[]): { dirs: Word[]; at: number } | null {
  const dirs: Word[] = [];
  let i = 1;
  for (; i < args.length && args[i]!.value.startsWith('-'); i++) {
    if (args[i]!.value === '-C' && args[i + 1]) dirs.push(args[++i]!);
    else if (!GIT_GLOBAL_FLAGS.has(args[i]!.value)) return null;
  }
  return i < args.length ? { dirs, at: i } : null;
}

class StartResolver {
  private realRootValue: string | undefined;
  constructor(private readonly repoRoot: string) {}
  private get realRoot(): string { return this.realRootValue ??= realpathSync(this.repoRoot); }

  /** Whether a start path is the repository root or an ancestor of it. */
  startClass(word: Word, dirs: Dirs): 'root' | 'other' | 'unknown' {
    if (word.expand) return 'unknown';
    const expanded = expandBraces(word.pattern);
    if (!expanded) return 'unknown';
    let unknown = false;
    for (let pattern of expanded) {
      if (/^~\+(?:\/|$)/.test(pattern)) pattern = `.${pattern.slice(2)}`;
      else if (/^~(?:\/|$)/.test(pattern)) pattern = escapePattern(homedir()) + pattern.slice(1);
      else if (pattern.startsWith('~')) { unknown = true; continue; }
      const absolute = pattern.startsWith('/');
      if (globIndex(pattern) >= 0 || (!absolute && dirs === null)) { unknown = true; continue; }
      for (const base of absolute ? ['/'] : dirs!) {
        const path = resolve(base, unescapePattern(pattern));
        if (inside(relative(path, this.repoRoot))) return 'root';
        try {
          if (inside(relative(writeThroughPath(path), this.realRoot))) return 'root';
        } catch { unknown = true; }
      }
    }
    return unknown ? 'unknown' : 'other';
  }
}

/** Whole-repository recursion: rm -r, find -delete or -exec, and git clean -x or -X from the root or an ancestor. */
function recursionFinding(args: readonly Word[], dirs: Dirs, resolver: StartResolver): string | null {
  const program = args[0]?.value;
  if (!program || args[0]!.expand) return null;
  const starts = (words: readonly Word[], base: Dirs) => words.map(word => resolver.startClass(word, base));
  if (program === 'rm') {
    let operandsOnly = false, recursive = false;
    const operands: Word[] = [];
    for (const word of args.slice(1)) {
      if (!operandsOnly && word.value === '--') operandsOnly = true;
      else if (!operandsOnly && /^-[^-]/.test(word.value)) recursive ||= /[rR]/.test(word.value);
      else if (!operandsOnly && word.value.startsWith('--')) recursive ||= word.value === '--recursive';
      else operands.push(word);
    }
    return recursive && starts(operands, dirs).includes('root') ? 'rm -r of the repository root or an ancestor' : null;
  }
  if (program === 'find') {
    const rest = args.slice(1);
    const find = parseFind(rest);
    if (!find.writes) return null;
    return starts([...find.starts, ...(find.currentDirectory ? [DOT] : [])], dirs).some(c => c !== 'other')
      ? 'find -delete or -exec from the repository root, an ancestor or an unknown start' : null;
  }
  if (program === 'git') {
    const git = gitInvocation(args);
    const clean = git ? args[git.at]!.value === 'clean' : args.some(word => word.value === 'clean');
    if (!clean) return null;
    const options = git ? args.slice(git.at + 1) : args;
    if (!options.some(word => /^-[^-]*[xX]/.test(word.value))) return null;
    let base: Dirs = git ? dirs : null;
    for (const dir of git?.dirs ?? []) {
      base = dir.expand || dir.glob ? null : isAbsolute(dir.value) ? [resolve(dir.value)] : base && base.map(d => resolve(d, dir.value));
    }
    const pathspecs: Word[] = [];
    for (let n = 0; n < options.length; n++) {
      const value = options[n]!.value;
      if (value === '-e' || value === '--exclude') n++;
      else if (!value.startsWith('-')) pathspecs.push(options[n]!);
    }
    const classes = pathspecs.some(word => word.value.startsWith(':')) ? ['unknown'] : starts(pathspecs.length ? pathspecs : [DOT], base);
    return classes.some(c => c !== 'other') ? 'git clean -x or -X from the repository root, an ancestor or an unknown directory' : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Bash decision
// ---------------------------------------------------------------------------

/** The first denial for a Bash command line: recursive delete, then I1, then I2. `cwd` null means the directory is not known. */
export function bashSafetyDenial(command: string, cwd: string | null, scope: SafetyScope): Denial | null {
  const resolver = new StartResolver(scope.repoRoot);
  const parsed = simpleCommands(command, cwd);
  for (const { command: cmd, dirs } of parsed) {
    const recursion = recursionFinding(cmd.words, dirs, resolver);
    if (recursion) {
      return { guard: 'RecursiveDeleteGuard', reason: `The command runs ${recursion}.`, fix: 'Name the directories to clean below the repository root.' };
    }
  }
  for (const { command: cmd, dirs } of parsed) {
    const denial = credentialFinding(cmd, dirs);
    if (denial) return denial;
  }
  // HOME comes from the scope, the same source as the allowed roots.
  const home = scope.env.HOME ?? homedir();
  const targets = parsed.flatMap(({ command: cmd, dirs }) => (dirs ?? [null]).flatMap(dir => commandTargets(cmd, dir, home)));
  return writeTargetDenial(targets, scope, bashUserStep(command));
}
