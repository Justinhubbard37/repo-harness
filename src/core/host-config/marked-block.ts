import { HostConfigError, type FragmentEdit, type HostConfigStrategy, type TextRange } from './types';

/** The marked blocks that rh writes in Markdown host files, each with its one owner (#2841). */
export const MARKED_BLOCK_FRAGMENTS = {
  'global-working-rules': 'core',
} as const;
export type MarkedBlockSelector = keyof typeof MARKED_BLOCK_FRAGMENTS;

export function isMarkedBlockSelector(selector: string): selector is MarkedBlockSelector {
  return Object.hasOwn(MARKED_BLOCK_FRAGMENTS, selector);
}

export function markedBlockMarkers(selector: string): { readonly begin: string; readonly end: string } {
  return { begin: `<!-- BEGIN: repo-harness ${selector} -->`, end: `<!-- END: repo-harness ${selector} -->` };
}

export type MarkedBlockLayout =
  | { readonly kind: 'none' }
  | { readonly kind: 'unbalanced' }
  /** `end` is the offset after the END marker. */
  | { readonly kind: 'balanced'; readonly start: number; readonly end: number };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/** One BEGIN and one END marker, in that order, make a block; any other marker set is unbalanced. */
export function markedBlockLayout(content: string, selector: string): MarkedBlockLayout {
  const { begin, end } = markedBlockMarkers(selector);
  const beginCount = countOccurrences(content, begin);
  const endCount = countOccurrences(content, end);
  if (beginCount === 0 && endCount === 0) return { kind: 'none' };
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (beginCount !== 1 || endCount !== 1 || stop < start) return { kind: 'unbalanced' };
  return { kind: 'balanced', start, end: stop + end.length };
}

function eolOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function locate(content: string, selector: string): TextRange | null {
  const layout = markedBlockLayout(content, selector);
  if (layout.kind === 'unbalanced') throw new HostConfigError('host_config_invalid_state', `unbalanced repo-harness ${selector} markers; preserving the file`);
  return layout.kind === 'balanced' ? { start: layout.start, end: layout.end } : null;
}

/**
 * The block goes right after the last byte that is not CR or LF, behind two
 * line endings; a file with no such byte gets the block and one line ending at
 * the start. The final-newline state does not change, and `removeMarkedBlock`
 * takes out exactly these bytes. `block` has no final line ending.
 */
export function insertMarkedBlock(content: string, block: string): FragmentEdit {
  const eol = eolOf(content);
  const text = block.replace(/\r?\n/g, eol);
  const at = content.replace(/[\r\n]+$/, '').length;
  return { at, removed: '', inserted: at === 0 ? `${text}${eol}` : `${eol}${eol}${text}` };
}

/** The block, and up to two line endings directly before it; at the start of the file, the block and one line ending after it. */
export function removeMarkedBlock(content: string, selector: string): FragmentEdit {
  const range = locate(content, selector);
  if (!range) return { at: 0, removed: '', inserted: '' };
  const eol = eolOf(content);
  if (range.start === 0) {
    const end = content.startsWith(eol, range.end) ? range.end + eol.length : range.end;
    return { at: 0, removed: content.slice(0, end), inserted: '' };
  }
  let start = range.start;
  for (let count = 0; count < 2 && content.slice(start - eol.length, start) === eol; count += 1) start -= eol.length;
  return { at: start, removed: content.slice(start, range.end), inserted: '' };
}

/** The edit that sets the block to `block`: in place when the file has one, else by `insertMarkedBlock`. */
function apply(content: string, selector: string, block: string): FragmentEdit {
  const range = locate(content, selector);
  if (!range) return insertMarkedBlock(content, block);
  return { at: range.start, removed: content.slice(range.start, range.end), inserted: block.replace(/\r?\n/g, eolOf(content)) };
}

export function markedBlockDocumentIsEmpty(content: string): boolean {
  return content.trim() === '';
}

/** A marked block in a Markdown host file. The fragment is the text from BEGIN to the end of END. */
export const markedBlock: HostConfigStrategy<string> = { locate, apply };
