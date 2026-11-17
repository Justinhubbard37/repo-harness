import { jsonFragment, jsonDocumentIsEmpty, jsonFragmentValue, removeJsonFragment } from './json-fragment';
import { isMarkedBlockSelector, markedBlock, markedBlockDocumentIsEmpty, removeMarkedBlock } from './marked-block';
import { tomlFragment } from './toml-fragment';
import type { FragmentEdit, FragmentRecord, HostConfigStrategy } from './types';

/** How the gate finds, and takes out, a recorded fragment in a file of one format. */
export interface FragmentFormat {
  readonly strategy: HostConfigStrategy<any>;
  /** The edit that takes the fragment at the selector out of the content; `records` are the file's records that may prove a container rh created. */
  remove(content: string, selector: string, records: readonly FragmentRecord[]): FragmentEdit;
  /** The edit that sets the fragment at the selector back to its text in `backup`; a removal when `backup` does not hold it. */
  restore(content: string, selector: string, backup: string, records: readonly FragmentRecord[]): FragmentEdit;
  /** True when nothing but an empty document is left. */
  empty(content: string): boolean;
}

const TOML: FragmentFormat = {
  strategy: tomlFragment,
  remove: (content, selector) => tomlFragment.apply(content, selector, ''),
  restore: (content, selector, backup) => {
    const range = tomlFragment.locate(backup, selector);
    return tomlFragment.apply(content, selector, range ? backup.slice(range.start, range.end) : '');
  },
  empty: (content) => content.trim() === '',
};

const JSON_FORMAT: FragmentFormat = {
  strategy: jsonFragment,
  remove: removeJsonFragment,
  restore: (content, selector, backup, records) => {
    const value = jsonFragmentValue(backup, selector);
    return value === undefined ? removeJsonFragment(content, selector, records) : jsonFragment.apply(content, selector, value);
  },
  empty: jsonDocumentIsEmpty,
};

const MARKED_BLOCK: FragmentFormat = {
  strategy: markedBlock,
  remove: (content, selector) => removeMarkedBlock(content, selector),
  restore: (content, selector, backup) => {
    const range = markedBlock.locate(backup, selector);
    return range ? markedBlock.apply(content, selector, backup.slice(range.start, range.end)) : removeMarkedBlock(content, selector);
  },
  empty: markedBlockDocumentIsEmpty,
};

/**
 * The format of a fragment: a marked-block selector names its format, because
 * a linked rules file can have any name; else the file name decides. Null for
 * a fragment that no strategy owns.
 */
export function fragmentFormat(path: string, selector: string): FragmentFormat | null {
  if (isMarkedBlockSelector(selector)) return MARKED_BLOCK;
  if (path.endsWith('.toml')) return TOML;
  if (path.endsWith('.json')) return JSON_FORMAT;
  return null;
}
