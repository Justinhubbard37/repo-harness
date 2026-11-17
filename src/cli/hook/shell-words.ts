/**
 * A shell word reader for the safety hook. It is not a shell interpreter: it removes quotes, marks words that change at run time,
 * reads redirects and heredocs, and splits a command line into simple commands. Substitution bodies come back as their own token
 * streams, after the top-level stream.
 */
import { lstatSync, readlinkSync, statSync } from 'fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path';

export const escapePattern = (text: string) => text.replace(/[\\*?[\]{},~]/g, '\\$&');
export const unescapePattern = (pattern: string) => pattern.replace(/\\(.)/gs, '$1');

/**
 * Shell pattern match of one path segment. A nested bracket, a POSIX class or a bracket that does not compile matches every name, so
 * a check that asks "can this glob reach X" errs toward yes.
 */
export function segmentMatches(pattern: string, name: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    const negated = ch === '[' && (pattern[i + 1] === '!' || pattern[i + 1] === '^');
    // A `]` right after `[` or `[!` is a member of the bracket expression, not its end.
    const close = ch === '[' ? pattern.indexOf(']', i + (negated ? 3 : 2)) : -1;
    if (ch === '\\') source += (pattern[++i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (close > 0 && /\[/.test(pattern.slice(i + 1, close))) return true;
    else if (close > 0) {
      source += `[${negated ? '^' : ''}${unescapePattern(pattern.slice(i + (negated ? 2 : 1), close)).replace(/[\\\]]/g, '\\$&')}]`;
      i = close;
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // A match with or without case counts: the shell glob is case-sensitive, but `nocaseglob` and the filesystem are not.
  // `u` folds `ſ` to `s` as APFS does.
  try { return new RegExp(`^${source}$`, 'u').test(name) || new RegExp(`^${source}$`, 'iu').test(name); } catch { return true; }
}

/** Index of the first unescaped glob character of a pattern, or -1. */
export function globIndex(pattern: string): number {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') i++;
    else if ('*?['.includes(pattern[i]!)) return i;
  }
  return -1;
}

export const BRACE_LIMIT = 1024;
class BraceLimit extends Error {}

/** The words of a `{a..b[..step]}` sequence, or null when the text is not one. */
function braceSequence(inner: string): string[] | null {
  const match = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(inner);
  if (!match) return null;
  const [, a, b, c, d, increment] = match;
  const start = a !== undefined ? Number(a) : c!.charCodeAt(0);
  const end = a !== undefined ? Number(b) : d!.charCodeAt(0);
  const step = (Math.abs(Number(increment ?? 1)) || 1) * (start <= end ? 1 : -1);
  if (![start, end, step].every(Number.isSafeInteger) || Math.abs(end - start) / Math.abs(step) >= BRACE_LIMIT) throw new BraceLimit();
  // A leading zero pads every number to the wider bound, sign included.
  const width = a !== undefined && (/^-?0\d/.test(a) || /^-?0\d/.test(b!)) ? Math.max(a.length, b!.length) : 0;
  const format = (n: number) => a === undefined ? String.fromCharCode(n)
    : n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0');
  const items: string[] = [];
  for (let n = start; step > 0 ? n <= end : n >= end; n += step) items.push(format(n));
  return items;
}

/** The patterns from the first expandable unescaped brace pair, or null when the pattern has none. */
function braceAlternatives(word: string): string[] | null {
  for (let open = 0; open < word.length; open++) {
    if (word[open] === '\\') { open++; continue; }
    if (word[open] !== '{') continue;
    const commas: number[] = [];
    let depth = 0, close = -1;
    for (let i = open; i < word.length && close < 0; i++) {
      if (word[i] === '\\') i++;
      else if (word[i] === '{') depth++;
      else if (word[i] === '}' && --depth === 0) close = i;
      else if (word[i] === ',' && depth === 1) commas.push(i);
    }
    if (close < 0) continue;
    const items = commas.length
      ? [open, ...commas].map((at, n) => word.slice(at + 1, [...commas, close][n]))
      : braceSequence(word.slice(open + 1, close));
    if (items) return items.map(item => word.slice(0, open) + item + word.slice(close + 1));
  }
  return null;
}

/** Brace expansion of one pattern in the shell's left-to-right order, before tilde and glob expansion; null above the word limit. */
export function expandBraces(word: string): string[] | null {
  const done: string[] = [];
  const pending = [word];
  try {
    while (pending.length) {
      const current = pending.pop()!;
      const items = braceAlternatives(current);
      if (items) pending.push(...items.reverse()); else done.push(current);
      if (done.length + pending.length > BRACE_LIMIT) return null;
    }
  } catch (error) {
    if (error instanceof BraceLimit) return null;
    throw error;
  }
  return done;
}

/** The path the kernel writes through: every symlink is followed, a dangling one too, before the next `..`. Throws when it cannot resolve. */
export function writeThroughPath(path: string): string {
  const split = (value: string) => value.slice(parse(value).root.length).split(sep === '/' ? '/' : /[\\/]/);
  const pending = split(path);
  let current = parse(path).root;
  for (let links = 0; pending.length;) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    if (!lstatSync(next, { throwIfNoEntry: false })?.isSymbolicLink()) { current = next; continue; }
    if (++links > 40) throw Object.assign(new Error(`too many symbolic links: ${path}`), { code: 'ELOOP' });
    // The raw link target is walked part by part, so a link inside it is followed before its `..`.
    const link = readlinkSync(next);
    pending.unshift(...split(link));
    if (isAbsolute(link)) current = parse(link).root;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** `pattern` is `value` with each quoted or escaped glob, brace or tilde character escaped by a backslash. */
export interface Word {
  readonly kind: 'word';
  value: string;
  pattern: string;
  /** A parameter, command or arithmetic substitution, or an ANSI-C string, can change the word at run time. */
  expand: boolean;
  /** An unquoted glob or brace character. */
  glob: boolean;
  /** A quote or a backslash appears in the word. */
  quoted: boolean;
  /** An unquoted `NAME=` or `NAME+=` prefix. */
  assign: boolean;
}

interface Op {
  readonly kind: 'op';
  readonly value: string;
  /** The body of a `<<` or `<<-` heredoc. */
  body?: string;
}

type Token = Word | Op;

/** The top-level token stream first; then the body of each substitution, outermost last. */
type Streams = Token[][];

const HEREDOC_HEAD = /"\$\(cat <<\s?'([A-Za-z_][A-Za-z0-9_]*)'\n/y;
const REDIRECT = /^(\d*)(>>|>\||>&|>|<>|<&|<<<|<<-|<<|<|&>>|&>)$/;

/**
 * The `"$(cat <<'D' ... D\n)"` span at `at`, or null. The body has no `$`, backtick, `\`, `"` or delimiter line, so the shell
 * prints it as text, and the lexer reads it as one quoted literal word (a commit or PR body written this way stays one argument).
 */
function heredocLiteral(text: string, at: number): { end: number; body: string } | null {
  HEREDOC_HEAD.lastIndex = at;
  const head = HEREDOC_HEAD.exec(text);
  if (!head) return null;
  const close = `\n${head[1]}\n)"`;
  const start = HEREDOC_HEAD.lastIndex;
  const end = text.indexOf(close, start - 1);
  if (end < 0) return null;
  const body = text.slice(start, end);
  if (/[$`\\"]/.test(body) || body.split('\n').includes(head[1]!)) return null;
  return { end: end + close.length, body };
}

interface Frame { tokens: Token[]; closer: ')' | '`' | null; depth: number; quote: boolean }

export function lex(text: string): Streams {
  const streams: Token[][] = [[]];
  const frames: Frame[] = [{ tokens: streams[0]!, closer: null, depth: 0, quote: false }];
  let word: Word | null = null;
  // The outer word of each open substitution; it continues after the substitution closes.
  const outerWords: (Word | null)[] = [];
  const frame = () => frames.at(-1)!;
  const current = (): Word => word ??= { kind: 'word', value: '', pattern: '', expand: false, glob: false, quoted: false, assign: false };
  const literal = (ch: string) => { const w = current(); w.value += ch; w.pattern += escapePattern(ch); w.quoted = true; };
  const flush = () => { if (word) frame().tokens.push(word); word = null; };
  const push = (closer: ')' | '`') => {
    // The `$` marks where the substitution's run-time text goes in the outer word.
    const outer = current();
    outer.expand = true; outer.value += '$'; outer.pattern += '$';
    outerWords.push(word);
    word = null;
    frames.push({ tokens: [], closer, depth: 0, quote: false });
  };
  const pop = () => {
    flush();
    const done = frames.pop()!;
    streams.push(done.tokens);
    word = outerWords.pop() ?? null;
  };
  const readHeredocs = (from: number): number => {
    const tokens = frame().tokens;
    let start = tokens.length;
    while (start > 0 && !(tokens[start - 1]!.kind === 'op' && (tokens[start - 1] as Op).value === '\n')) start--;
    const pending = tokens.slice(start).flatMap((token, n, line) => token.kind === 'op' && /<<-?$/.test(token.value) && token.body === undefined
      ? [{ op: token as Op, delimiter: line[n + 1] }] : []);
    let at = from;
    for (const { op, delimiter } of pending) {
      const end = delimiter?.kind === 'word' ? delimiter.value : null;
      const lines: string[] = [];
      while (at < text.length) {
        const next = text.indexOf('\n', at);
        const raw = text.slice(at, next < 0 ? text.length : next);
        at = next < 0 ? text.length : next + 1;
        if ((op.value.endsWith('-') ? raw.replace(/^\t+/, '') : raw) === end) break;
        lines.push(raw);
      }
      op.body = lines.join('\n');
    }
    return at;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const f = frame();
    if (ch === '\\') {
      if (i + 1 === text.length) break;
      if (text[i + 1] === '\n') { i++; continue; }
      if (f.quote && !'$`"\\'.includes(text[i + 1]!)) { literal('\\'); continue; }
      literal(text[++i]!);
      continue;
    }
    if (f.quote) {
      if (ch === '"') { f.quote = false; continue; }
      if (ch === '`') { push('`'); continue; }
      if (ch === '$' && text[i + 1] === '(') { i++; push(')'); continue; }
      if (ch === '$') current().expand = true;
      literal(ch);
      continue;
    }
    if (f.closer === '`' && ch === '`') { pop(); continue; }
    if (f.closer === ')' && ch === ')' && f.depth === 0) { pop(); continue; }
    if (ch === '"') {
      const span = heredocLiteral(text, i);
      if (span) {
        current().quoted = true;
        for (const c of span.body) literal(c);
        i = span.end - 1;
        continue;
      }
      current().quoted = true;
      f.quote = true;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) { literal(text.slice(i + 1)); break; }
      current().quoted = true;
      for (const c of text.slice(i + 1, end)) literal(c);
      i = end;
      continue;
    }
    if (ch === '`') { push('`'); continue; }
    if (ch === '$' && text[i + 1] === '(') { i++; push(')'); continue; }
    // In `$'...'` a backslash escapes the quote, so `$'\''` is one character; the joint decision on F4 puts it outside the strict form.
    if (ch === '$' && text[i + 1] === "'") {
      let end = i + 2;
      while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1;
      const w = current();
      w.expand = true; w.quoted = true;
      for (const c of text.slice(i + 2, end)) literal(c);
      if (end >= text.length) break;
      i = end;
      continue;
    }
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 0, end = i + 1;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      const inner = text.slice(i, end + 1);
      const w = current();
      w.value += inner; w.pattern += escapePattern(inner); w.expand = true;
      if (/\$\(|`/.test(inner)) streams.push(...lex(inner.slice(2, -1)));
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      if (ch === '\n') { i = readHeredocs(i + 1) - 1; f.tokens.push({ kind: 'op', value: '\n' }); }
      continue;
    }
    if (ch === '#' && !word) {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (';|&<>'.includes(ch)) {
      let fd = '';
      // In 2>file, 2 is a descriptor. In "2">file it remains an argument.
      const before = word as Word | null;
      if ((ch === '<' || ch === '>') && before && !before.quoted && !before.expand && /^\d+$/.test(before.value)) { fd = before.value; word = null; }
      flush();
      let op = ch;
      const two = text.slice(i, i + 3);
      for (const candidate of ['<<<', '<<-', '&>>', ';;', ';&', '&&', '||', '|&', '>>', '>|', '>&', '<>', '<&', '<<', '&>']) {
        if (two.startsWith(candidate)) { op = candidate; break; }
      }
      i += op.length - 1;
      if ((op === '<' || op === '>') && text[i + 1] === '(') {
        i++;
        current();
        push(')');
        continue;
      }
      f.tokens.push({ kind: 'op', value: fd + op });
      continue;
    }
    if (ch === '(' || ch === ')') {
      flush();
      if (ch === '(') f.depth++; else f.depth--;
      f.tokens.push({ kind: 'op', value: ch });
      continue;
    }
    const w = current();
    if ('*?[{'.includes(ch)) w.glob = true;
    // `$name` and `$1` change the word at run time.
    if (ch === '$') w.expand = true;
    if (ch === '=' && !w.quoted && !w.expand && !w.assign && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(w.value)) w.assign = true;
    w.value += ch; w.pattern += ch;
  }
  while (frames.length > 1) pop();
  flush();
  return streams;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Redirect { readonly op: string; readonly target: Word | null; readonly body?: string }

export interface Command {
  readonly kind: 'command';
  readonly words: Word[];
  readonly redirects: Redirect[];
  /** The separator before the pipeline that holds this command; '' at the start. */
  readonly before: string;
  /** The operator right after this command: `|` inside a pipeline, else the list separator; 'end' at the end. */
  readonly after: string;
  readonly last: boolean;
  readonly size: number;
}

/** A command, or the `(` or `)` of a subshell or group. */
export type Step = Command | { readonly kind: '(' | ')' };

const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);

export function commands(tokens: readonly Token[]): Step[] {
  const result: Step[] = [];
  let words: Word[] = [], redirects: Redirect[] = [], before = '', inPipeline: Command[] = [];
  const end = (separator: string) => {
    // A control word starts a compound command; the simple command that follows it runs like any other.
    while (words[0] && !words[0].quoted && CONTROL_WORDS.has(words[0].value)) words.shift();
    if (words.length || redirects.length) {
      const command: Command = { kind: 'command', words, redirects, before, after: separator, last: false, size: 0 };
      result.push(command); inPipeline.push(command);
    }
    words = []; redirects = [];
    if (separator !== '|' && separator !== '|&') {
      inPipeline.forEach((command, n) => Object.assign(command, { last: n === inPipeline.length - 1, size: inPipeline.length }));
      inPipeline = [];
      if (separator !== '(' && separator !== ')') before = separator;
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'word') { words.push(token); continue; }
    const redirect = REDIRECT.exec(token.value);
    if (redirect) {
      const next = tokens[i + 1];
      const target = next?.kind === 'word' ? next : null;
      if (target) i++;
      redirects.push({ op: token.value, target, body: token.body });
      continue;
    }
    if (token.value === '(' || token.value === ')') { end(token.value); result.push({ kind: token.value }); continue; }
    end(token.value);
  }
  end('end');
  return result;
}

// ---------------------------------------------------------------------------
// The directory each command runs from
// ---------------------------------------------------------------------------

/** The shell's directory set: one directory that is certain, or null when the reader cannot place the working directory. */
export type Dirs = readonly string[] | null;

/** Programs after which the shell's directory is not known. */
const MOVES_SHELL = new Set(['pushd', 'popd', 'source', '.', 'eval', 'builtin', 'command', 'exec']);

export interface SimpleCommand { readonly command: Command; readonly dirs: Dirs }

/**
 * Each simple command of a command line with the directory it runs from. A `cd` moves the directory only for the commands that
 * run after it succeeds: the rest of its `&&` chain. A command after `;`, a newline, `||` or `&` may run after a failed `cd`, so
 * its directory is not certain. A substitution body runs from the starting directory when the top-level line never moves it.
 */
export function simpleCommands(text: string, cwd: string | null): SimpleCommand[] {
  const result: SimpleCommand[] = [];
  const streams = lex(text).map(tokens => commands(tokens));
  const moves = streams[0]!.some(step => step.kind === 'command' && step.words[0] !== undefined
    && ((!step.words[0].quoted && step.words[0].value === 'cd') || MOVES_SHELL.has(step.words[0].value)));
  streams.forEach((steps, index) => {
    let dirs: Dirs = cwd !== null && (index === 0 || !moves) ? [cwd] : null;
    // Set while a `cd` of the current `&&` chain decided `dirs`.
    let chainCd = false;
    // A subshell does not move the shell that started it.
    const outer: Array<{ dirs: Dirs; chainCd: boolean }> = [];
    for (const step of steps) {
      if (step.kind !== 'command') {
        if (step.kind === '(') outer.push({ dirs, chainCd });
        else ({ dirs, chainCd } = outer.pop() ?? { dirs: null, chainCd: false });
        continue;
      }
      if (chainCd && step.before !== '&&') { dirs = null; chainCd = false; }
      result.push({ command: step, dirs });
      const program = step.words[0];
      if (program && !program.quoted && program.value === 'cd') {
        // A cd before `|` runs in a subshell in bash and zsh, so it never moves the shell.
        if (step.size > 1 && !step.last) continue;
        // After `||` the cd may be skipped while its `&&` chain still runs.
        dirs = step.size === 1 && step.after === '&&' && step.before !== '||' ? cdTarget(step, dirs) : null;
        chainCd = dirs !== null;
      } else if (program && MOVES_SHELL.has(program.value)) dirs = null;
    }
  });
  return result;
}

/** The existing directory that a literal `cd DIR` enters, or null. */
function cdTarget(cmd: Command, dirs: Dirs): Dirs {
  const operands = cmd.words.slice(1);
  const operand = operands[0];
  if (operands.length !== 1 || operand!.expand || operand!.glob || !operand!.value || /^[-~]/.test(operand!.value)) return null;
  const target = isAbsolute(operand!.value) ? resolve(operand!.value) : dirs && dirs[0] !== undefined ? resolve(dirs[0], operand!.value) : null;
  return target !== null && statSync(target, { throwIfNoEntry: false })?.isDirectory() ? [target] : null;
}
