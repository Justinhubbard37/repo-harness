import { jsonFragment, jsonDocumentIsEmpty, jsonFragmentValue, removeJsonFragment } from './json-fragment';
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

/** The format of a host file follows from its name; null for a file that no strategy owns. */
export function fragmentFormat(path: string): FragmentFormat | null {
  if (path.endsWith('.toml')) return TOML;
  if (path.endsWith('.json')) return JSON_FORMAT;
  return null;
}
