/**
 * The safety hook (#2916): the agent-layer security bar on the PreToolUse bash and edit routes of Claude, Codex and Pi.
 *
 * - I1: refuse a call that prints or sends a credential store. Secret redaction stays as the second layer.
 * - I2: refuse a removal or overwrite of an existing file outside the agent's worktree, the managed worktree root, the system temp
 *   directory and the host agent's own memory and plan directories, unless rh's install ledger records the file as rh-created.
 *   Creates and appends pass everywhere. The user authorizes anything else locally by running the command in their own shell,
 *   which no hook sees.
 * - Recursive delete: refuse `rm -r`, `find -delete`/`-exec` and `git clean -x` from the repository root or an ancestor.
 *
 * The threat model is accidents. A target built at run time, a script or binary that writes, and a hidden alias are accepted
 * residuals; only a removal whose target is not known fails closed.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs';
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
 * - `destroy` removes or replaces the entry itself (rm, an mv source, sed -i): the leaf link is not followed.
 * - `change` writes content into an existing file (truncate, shred): the kernel follows the leaf link to its referent.
 * - `overwrite` creates or replaces content (a redirect, cp, tee): it follows the leaf link too.
 * `destroy` and `change` act only on an existing file, so an unknown target denies; an unknown `overwrite` target passes.
 */
export type TargetKind = 'destroy' | 'change' | 'overwrite';

/** One write target. `path` is absolute, or null when the shell decides it at run time. */
export interface WriteTarget {
  readonly kind: TargetKind;
  readonly via: string;
  readonly spelled: string;
  readonly path: string | null;
  /** The path is the literal directory before a glob or a parameter; the write lands below it. */
  readonly glob?: true;
  /**
   * cp, mv and ln write `<path>/<name>` for each source name when `path` is an existing directory; the directory itself is not
   * written. `names` is null when a source name is not known, and then every existing child can be the target. cp writes
   * through an existing child link (`follow`); mv and ln replace the child entry.
   */
  readonly into?: { readonly names: readonly string[] | null; readonly follow: boolean };
}

const inside = (rel: string) => !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
const atOrBelow = (root: string, path: string) => inside(relative(root, path));

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

/** The path itself, with every directory above it resolved; the leaf link is not followed, as rm and mv do not follow it. */
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

class TargetJudge {
  private rootsValue: Root[] | undefined;
  constructor(private readonly scope: SafetyScope, private readonly userStep: string) {}
  private get roots(): Root[] { return this.rootsValue ??= allowedRoots(this.scope); }

  denial(target: WriteTarget): Denial | null {
    const needsTarget = target.kind !== 'overwrite';
    if (target.path === null) return needsTarget ? unknownTargetDenial(target, this.roots, this.userStep) : null;
    if (/^\/dev\//.test(target.path)) return null;
    if (target.glob) return this.globDenial(target, target.path);
    let path: string;
    try {
      path = target.kind === 'destroy' ? leafPath(target.path) : writeThroughPath(target.path);
    } catch {
      // A path that does not resolve (a link loop, an unreadable directory) cannot be checked.
      return needsTarget ? unknownTargetDenial(target, this.roots, this.userStep) : null;
    }
    if (target.into && statSync(path, { throwIfNoEntry: false })?.isDirectory()) return this.childDenial(target, target.into, path);
    return this.existingDenial(target, path);
  }

  /** A copy into a directory writes one child per source name; without the names, every existing child is a possible target. */
  private childDenial(target: WriteTarget, into: NonNullable<WriteTarget['into']>, dir: string): Denial | null {
    let names = into.names;
    if (names === null) {
      try { names = readdirSync(dir); } catch { return unknownTargetDenial(target, this.roots, this.userStep); }
      if (names.length > CHILD_LIMIT) return unknownTargetDenial(target, this.roots, this.userStep);
    }
    for (const name of names) {
      let child = join(dir, name);
      try { if (into.follow) child = writeThroughPath(child); } catch { return unknownTargetDenial(target, this.roots, this.userStep); }
      const denial = this.existingDenial(target, child);
      if (denial) return denial;
    }
    return null;
  }

  private existingDenial(target: WriteTarget, path: string): Denial | null {
    if (this.roots.some(root => underRoot(root, path))) return null;
    const exists = target.kind === 'destroy' ? lstatSync(path, { throwIfNoEntry: false }) !== undefined : existsSync(path);
    if (!exists || ledgerCreated(path, this.scope.env)) return null;
    return outsideDenial(target, path, this.roots, this.userStep);
  }

  /**
   * A glob or a parameter decides its target at run time, below its literal directory, so the directory decides: inside an
   * allowed root the call passes, and an existing directory outside them takes the outside rule.
   */
  private globDenial(target: WriteTarget, dir: string): Denial | null {
    let path: string;
    try { path = writeThroughPath(dir); } catch {
      return target.kind === 'overwrite' ? null : unknownTargetDenial(target, this.roots, this.userStep);
    }
    if (this.roots.some(root => underRoot(root, path, true)) || !existsSync(path) || ledgerCreated(path, this.scope.env)) return null;
    return outsideDenial(target, path, this.roots, this.userStep);
  }
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
    reason: `I2: the target ${target.spelled} of ${target.via} is not known before the command runs, and ${target.via} removes or changes `
      + `an existing file. Allowed roots: ${rootList(roots)}.`,
    fix: `Write the target as a literal path inside an allowed root from a known working directory, or ${userStep}.`,
    askable: true,
  };
}

/** The first I2 denial among the targets. `userStep` says how the user does the call themselves. */
export function writeTargetDenial(targets: readonly WriteTarget[], scope: SafetyScope, userStep: string | ((path: string) => string)): Denial | null {
  for (const target of targets) {
    const step = typeof userStep === 'string' ? userStep : userStep(target.path ?? target.spelled);
    const denial = new TargetJudge(scope, step).denial(target);
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
  return candidates.some(entry => (!entry.startsWith('.') || name.startsWith('.')) && segmentMatches(name, entry)
    && namesCredentialStore(`${dir}${entry}`));
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
 * The absolute paths that a word names from each directory of the set, after brace expansion. A word that keeps a glob or a
 * parameter names its literal directory before the first such character (`glob`); a leading `$HOME` and `~` are literal. Null
 * when the shell decides the directory at run time.
 */
function wordTargets(word: Word, dirs: Dirs): Array<{ path: string; glob: boolean }> | null {
  const result: Array<{ path: string; glob: boolean }> = [];
  for (let pattern of expandBraces(word.pattern) ?? [word.pattern]) {
    const home = /^(?:~|\$HOME|\$\\\{HOME\\\})(?=\/|$)/.exec(pattern);
    if (home) pattern = escapePattern(homedir()) + pattern.slice(home[0].length);
    // `~+` is the working directory; `~-` and `~user` are not known here.
    else if (/^~\+(?:\/|$)/.test(pattern)) pattern = `.${pattern.slice(2)}`;
    else if (pattern.startsWith('~')) return null;
    const stop = expansionIndex(pattern, word.expand);
    if (stop === 0 && pattern[0] === '$') return null;
    const literal = unescapePattern(stop < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', stop) + 1)) || '.';
    if (!isAbsolute(literal) && dirs === null) return null;
    // The path keeps its `..` parts: the kernel follows each link before the `..` after it.
    for (const base of isAbsolute(literal) ? [''] : dirs!) result.push({ path: base ? `${base}${sep}${literal}` : literal, glob: stop >= 0 });
  }
  return result;
}

/** The first unescaped glob or brace character, or `$` in a word that expands at run time; -1 when the word is literal. */
function expansionIndex(pattern: string, expand: boolean): number {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if ('*?[{'.includes(pattern[i]!) || (expand && pattern[i] === '$')) return i;
  }
  return -1;
}

function targetsOf(kind: TargetKind, via: string, word: Word, dirs: Dirs, into?: WriteTarget['into']): WriteTarget[] {
  const found = wordTargets(word, dirs);
  if (found === null) return [{ kind, via, spelled: word.value, path: null }];
  return found.map(({ path, glob }) => ({ kind, via, spelled: word.value, path, ...(glob ? { glob: true as const } : {}), ...(into ? { into } : {}) }));
}

/** Operands after options; `valued` options take the next word unless glued (`-tDIR`, `--suffix=x`). */
function operandsOf(args: readonly Word[], valued: ReadonlySet<string>): { operands: Word[]; values: Map<string, Word> } {
  const operands: Word[] = [];
  const values = new Map<string, Word>();
  let only = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (only || !word.value.startsWith('-') || word.value === '-') { operands.push(word); continue; }
    if (word.value === '--') { only = true; continue; }
    if (valued.has(word.value) && args[i + 1]) values.set(word.value, args[++i]!);
  }
  return { operands, values };
}

const MOVE_VALUED = new Set(['-S', '--suffix']);

/** The words that the shell passes after brace expansion. */
const braceWords = (word: Word): Word[] => (expandBraces(word.pattern) ?? [word.pattern])
  .map(pattern => pattern === word.pattern ? word : { ...word, pattern, value: unescapePattern(pattern) });

/**
 * A target-directory option (`-t`, `-T`, `--target-directory`, `--no-target-directory`, also inside combined short options)
 * changes which operand is the destination. Its glued value (`-tDIR`, `--target-directory=DIR`) is an operand.
 */
function targetOption(word: Word): Word[] | null {
  const short = /^-(?!-)[a-zA-Z]*?([tT])(.*)$/.exec(word.value);
  const long = /^--(?:no-)?target-directory(?:=(.*))?$/.exec(word.value);
  if (!short && !long) return null;
  const value = short ? (short[1] === 't' ? short[2]! : '') : long![1] ?? '';
  return value ? [{ ...word, value, pattern: word.pattern.slice(word.pattern.length - escapePattern(value).length) }] : [];
}

/**
 * cp and ln, after brace expansion: the last operand is the destination, written into a directory as each source's name.
 * When the hook cannot classify the operands (a target-directory option, fewer than two operands), every operand is a possible
 * write target. mv removes or replaces each of its operands, so every operand, a glued target directory too, is a removal target.
 */
function destinationTargets(program: string, args: readonly Word[], dirs: Dirs): WriteTarget[] {
  const words = args.flatMap(braceWords);
  const glued = words.map(targetOption);
  if (program === 'mv') {
    return [...operandsOf(words, new Set()).operands, ...glued.flatMap(found => found ?? [])].flatMap(word => targetsOf('destroy', 'mv', word, dirs));
  }
  const { operands } = operandsOf(words, MOVE_VALUED);
  if (glued.some(found => found !== null) || operands.length < 2) {
    return [...operands, ...glued.flatMap(found => found ?? [])].flatMap(word => targetsOf('overwrite', program, word, dirs));
  }
  const sources = operands.slice(0, -1);
  const sourced = sources.map(word => sourceNames(word));
  const names = sourced.some(list => list === null) ? null : sourced.flatMap(list => list!);
  return targetsOf('overwrite', program, operands.at(-1)!, dirs, { names, follow: program === 'cp' });
}

/** The names that a copy or move source gives its destination children after brace expansion; null when a glob or a parameter decides one. */
function sourceNames(word: Word): string[] | null {
  if (word.expand) return null;
  const names: string[] = [];
  for (const item of expandBraces(word.pattern) ?? [word.pattern]) {
    const pattern = item.replace(/\/+$/, '');
    if (globIndex(pattern) >= 0 || pattern.startsWith('~')) return null;
    names.push(basename(unescapePattern(pattern)));
  }
  return names;
}

/** Python and Node one-liners: literal file writes and removals in the script text. */
function scriptTargets(program: string, source: string, dirs: Dirs): WriteTarget[] {
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
  return found.flatMap(([kind, path]) => {
    const word: Word = { kind: 'word', value: path, pattern: escapePattern(path), expand: false, glob: false, quoted: true, assign: false };
    return targetsOf(kind, program, word, dirs);
  });
}

const FIND_RUNS = /^-(?:exec|execdir|ok|okdir)$/;
const FIND_EXEC_READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ls', 'stat', 'file', 'du', 'diff', 'cmp', 'cut', 'tr', 'jq',
  'echo', 'printf', 'test', 'basename', 'dirname', 'realpath', 'readlink', 'sort']);

/** find writes when it deletes or runs a program that is not a reader. */
function findWrites(args: readonly Word[]): boolean {
  return args.some((word, n) => word.value === '-delete' || (FIND_RUNS.test(word.value) && !FIND_EXEC_READERS.has(args[n + 1]?.value ?? '')));
}

/** The start paths of find, before the first expression word. */
function findStarts(args: readonly Word[]): Word[] {
  let i = 0;
  const starts: Word[] = [];
  for (; i < args.length && /^-[HLPEXdsx]$|^-O\d$|^-f$/.test(args[i]!.value); i++) if (args[i]!.value === '-f' && args[i + 1]) starts.push(args[++i]!);
  for (; i < args.length && !/^[-(!)]/.test(args[i]!.value); i++) starts.push(args[i]!);
  return starts;
}

const DOT: Word = { kind: 'word', value: '.', pattern: '.', expand: false, glob: false, quoted: false, assign: false };
const TRUNCATE_VALUED = new Set(['-s', '--size', '-r', '--reference']);
const SHRED_VALUED = new Set(['-n', '--iterations', '-s', '--size', '--random-source']);
const SED_VALUED = new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']);

/** The write targets of one simple command. */
function commandTargets(cmd: Command, dirs: Dirs): WriteTarget[] {
  const targets: WriteTarget[] = [];
  for (const redirect of cmd.redirects) {
    const op = redirect.op.replace(/^\d+/, '');
    const target = redirect.target;
    if (!target || !['>', '>|', '&>', '>&'].includes(op)) continue;
    // Descriptor duplication or closure, such as 2>&1, has no file.
    if (op === '>&' && /^(?:\d+|-)$/.test(target.value) && !target.quoted) continue;
    targets.push(...targetsOf('overwrite', 'a redirect', target, dirs));
  }
  const words = cmd.words;
  const at = programAt(words);
  if (at < 0 || words[at]!.quoted) return targets;
  const program = words[at]!.value;
  const args = words.slice(at + 1);
  const operands = (valued: ReadonlySet<string> = new Set()) => operandsOf(args, valued).operands;
  switch (program) {
    case 'rm': case 'unlink':
      for (const word of operands()) targets.push(...targetsOf('destroy', program, word, dirs));
      break;
    case 'shred': {
      const removes = args.some(word => /^-[a-zA-Z]*u/.test(word.value) || /^--remove(?:=|$)/.test(word.value));
      for (const word of operands(SHRED_VALUED)) {
        targets.push(...targetsOf('change', program, word, dirs));
        if (removes) targets.push(...targetsOf('destroy', program, word, dirs));
      }
      break;
    }
    case 'truncate':
      for (const word of operands(TRUNCATE_VALUED)) targets.push(...targetsOf('change', program, word, dirs));
      break;
    case 'mv': case 'cp':
      targets.push(...destinationTargets(program, args, dirs));
      break;
    case 'ln':
      // Without -f, ln refuses an existing destination.
      if (args.some(word => /^-[a-zA-Z]*f/.test(word.value) || word.value === '--force')) targets.push(...destinationTargets(program, args, dirs));
      break;
    case 'tee':
      if (!args.some(word => /^-[a-zA-Z]*a/.test(word.value) || word.value === '--append')) {
        for (const word of operands()) targets.push(...targetsOf('overwrite', program, word, dirs));
      }
      break;
    case 'sed': {
      const inPlace = args.findIndex(word => /^-i/.test(word.value) || /^--in-place(?:=|$)/.test(word.value));
      if (inPlace < 0) break;
      // BSD sed takes the backup suffix as the next word: `sed -i '' s/a/b/ file`.
      const words = args.filter((word, n) => !(n === inPlace + 1 && args[inPlace]!.value === '-i' && word.value === ''));
      let files = operandsOf(words, SED_VALUED).operands;
      if (!words.some(word => SED_VALUED.has(word.value) || /^--(?:expression|file)=/.test(word.value))) files = files.slice(1);
      for (const word of files) targets.push(...targetsOf('destroy', program, word, dirs));
      break;
    }
    case 'dd':
      for (const word of args.filter(arg => arg.value.startsWith('of='))) {
        const file = { ...word, value: word.value.slice(3), pattern: word.pattern.slice(3) };
        targets.push(...targetsOf('overwrite', program, file, dirs));
      }
      break;
    case 'find':
      if (findWrites(args)) {
        const starts = findStarts(args);
        for (const word of starts.length ? starts : [DOT]) targets.push(...targetsOf('destroy', 'find', word, dirs));
      }
      break;
    default:
      if (/^python(?:3(?:\.\d+)?)?$/.test(program) || program === 'node') {
        const flag = args.findIndex(word => ['-c', '-e', '--eval'].includes(word.value));
        const heredoc = cmd.redirects.find(redirect => redirect.body !== undefined)?.body ?? '';
        targets.push(...scriptTargets(program, flag >= 0 ? args[flag + 1]?.value ?? '' : heredoc, dirs));
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
    if (!findWrites(rest)) return null;
    const paths = findStarts(rest);
    return starts(paths.length ? paths : [DOT], dirs).some(c => c !== 'other')
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
  return writeTargetDenial(parsed.flatMap(({ command: cmd, dirs }) => commandTargets(cmd, dirs)), scope, bashUserStep(command));
}
