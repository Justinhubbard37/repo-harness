import { isDeepStrictEqual } from 'node:util';
import { HostConfigError, type FragmentEdit, type HostConfigStrategy, type TextRange } from './types';

/** The `~/.codex/config.toml` fragments that rh writes, each with its one owner (#2841). */
export const CODEX_CONFIG_FRAGMENTS = {
  default_mode_request_user_input: 'core',
  'mcp_servers.codegraph': 'architecture',
} as const;
export type CodexConfigSelector = keyof typeof CODEX_CONFIG_FRAGMENTS;

export function isCodexConfigSelector(selector: string): selector is CodexConfigSelector {
  return Object.hasOwn(CODEX_CONFIG_FRAGMENTS, selector);
}

type TomlTable = Record<string, unknown>;

function preserving(selector: string, detail: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', `${detail} for ${selector}; preserving configuration`);
}

function parse(content: string): TomlTable {
  return Bun.TOML.parse(content) as TomlTable;
}

/** The parsed value at the selector, and the parsed file without it. */
function split(content: string, selector: CodexConfigSelector): { value: unknown; rest: TomlTable } {
  const rest = parse(content);
  if (selector === 'default_mode_request_user_input') {
    const value = rest[selector];
    delete rest[selector];
    return { value, rest };
  }
  const servers = rest.mcp_servers as TomlTable | undefined;
  const value = servers?.codegraph;
  if (servers) {
    delete servers.codegraph;
    if (Object.keys(servers).length === 0) delete rest.mcp_servers;
  }
  return { value, rest };
}

const SPELLING: Record<CodexConfigSelector, string> = {
  default_mode_request_user_input: 'one default_mode_request_user_input = <value> line before the first table',
  'mcp_servers.codegraph': 'one [mcp_servers.codegraph] table under its own header line',
};

/**
 * The text span of one selector: the root-table key line, or the
 * `[mcp_servers.codegraph]` table up to the next table header. A table that
 * ends the file without a final line break also owns the line break before
 * its header, the pair that rh appends to such a file. The span must be the
 * only spelling of the selector: removing it must remove exactly that value
 * from the parsed file, so text inside strings or arrays never matches.
 */
function span(content: string, selector: CodexConfigSelector): TextRange | null {
  const { value, rest } = split(content, selector);
  if (value === undefined) return null;
  const rootKey = selector === 'default_mode_request_user_input';
  const pattern = rootKey
    ? /^default_mode_request_user_input\s*=.*(?:\r?\n|$)/gm
    : /^[ \t]*\[mcp_servers\.codegraph\][^\S\r\n]*(?:\r?\n|$)[\s\S]*?(?=^\s*\[|(?![\s\S]))/gm;
  // The key belongs to the root table; a profile table may use the same key.
  const tableStart = rootKey ? content.search(/^[ \t]*\[/m) : -1;
  const source = tableStart === -1 ? content : content.slice(0, tableStart);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new HostConfigError('host_config_invalid_state', `unsupported TOML spelling for ${selector}; preserving configuration. Write it as ${SPELLING[selector]}, then run the command again`);
  let start = matches[0]!.index!;
  const end = start + matches[0]![0].length;
  if (!rootKey && end === content.length && !content.endsWith('\n') && content[start - 1] === '\n') start -= content[start - 2] === '\r' ? 2 : 1;
  const range = { start, end };
  if (!isDeepStrictEqual(parse(content.slice(0, range.start) + content.slice(range.end)), rest)) throw preserving(selector, 'ambiguous TOML fragment');
  return range;
}

function selectorOf(selector: string): CodexConfigSelector {
  if (!isCodexConfigSelector(selector)) throw new HostConfigError('host_config_invalid_state', `not a Codex configuration selector: ${selector}`);
  return selector;
}

/** The parsed value at the selector, or undefined when the file does not set it. */
export function codexConfigValue(content: string, selector: CodexConfigSelector): unknown {
  return split(content, selector).value;
}

/** The selector's text in the file, or null when the file does not set it. */
export function codexConfigFragment(content: string, selector: CodexConfigSelector): string | null {
  const range = span(content, selector);
  return range ? content.slice(range.start, range.end) : null;
}

/** A table at the end of a file without a final line break: the line break before it, the table, and no final line break. */
function atFileEnd(lineBreak: string, value: string): string {
  return value === '' ? '' : `${lineBreak}${value.trimEnd()}`;
}

/**
 * Edits one selector of `~/.codex/config.toml`. The value is the whole
 * fragment text; '' removes the fragment. A new root key goes first, before
 * any table; a new table goes at the end. The inserted text has the span's
 * boundary, so a later lookup finds exactly the text that rh recorded.
 */
export const tomlFragment: HostConfigStrategy<string> = {
  locate: (content, selector) => span(content, selectorOf(selector)),
  apply(content, selector, value): FragmentEdit {
    const name = selectorOf(selector);
    const range = span(content, name);
    const removed = range ? content.slice(range.start, range.end) : '';
    const lineBreak = /^\r?\n/.exec(removed)?.[0];
    const edit = range
      ? { at: range.start, removed, inserted: lineBreak ? atFileEnd(lineBreak, value) : value }
      : name === 'default_mode_request_user_input' ? { at: 0, removed: '', inserted: value }
        : { at: content.length, removed: '', inserted: content === '' || content.endsWith('\n') ? value : atFileEnd('\n', value) };
    const next = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    try { parse(next); } catch (error) { throw new HostConfigError('host_config_invalid_state', `the ${selector} edit does not give valid TOML; preserving configuration`, { cause: error }); }
    return edit;
  },
};
