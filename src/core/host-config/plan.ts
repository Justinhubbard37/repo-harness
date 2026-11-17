import {
  HostConfigError,
  type FragmentEdit,
  type FragmentKind,
  type FragmentRecord,
  type FragmentRequest,
  type SkippedOverride,
} from './types';

export interface PlannedFragment {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  readonly edit: FragmentEdit;
  /** The active record of the same owner and selector, when this edit refreshes it. */
  readonly previous: FragmentRecord | null;
  /** The fragment's text in the result, as the strategy locates it: what the ledger records as `inserted`. */
  readonly text: string;
  /** The outermost container that this edit created, from the content before it. */
  readonly created: string | null;
}

export interface FilePlan {
  readonly file: string;
  /** The merged content; equal to the input when every edit is already in place. */
  readonly result: string;
  readonly fragments: readonly PlannedFragment[];
  readonly skipped: readonly SkippedOverride[];
}

function segments(selector: string): string[] {
  const parts = selector.split('.');
  if (parts.some((part) => part === '')) throw new HostConfigError('host_config_invalid_state', `invalid fragment selector: ${JSON.stringify(selector)}`);
  return parts;
}

/** True when one selector is the other or a parent of it. */
function selectorsNest(a: string, b: string): boolean {
  const left = segments(a), right = segments(b);
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.every((part, index) => longer[index] === part);
}

function overlap(file: string, detail: string): HostConfigError {
  return new HostConfigError('host_config_fragment_overlap', `${file}: ${detail}`);
}

function checkSelectors(file: string, requests: readonly FragmentRequest[], active: readonly FragmentRecord[]): void {
  for (const [index, request] of requests.entries()) {
    for (const other of requests.slice(index + 1)) {
      if (selectorsNest(request.selector, other.selector)) {
        throw overlap(file, `${request.owner}:${request.selector} and ${other.owner}:${other.selector} edit one fragment`);
      }
    }
    for (const record of active) {
      if (record.selector === request.selector ? record.owner !== request.owner : selectorsNest(record.selector, request.selector)) {
        throw overlap(file, `${request.owner}:${request.selector} meets the recorded fragment ${record.owner}:${record.selector}`);
      }
    }
  }
}

function checkEdit(file: string, content: string, request: FragmentRequest, edit: FragmentEdit): void {
  const valid = Number.isInteger(edit.at) && edit.at >= 0 && edit.at + edit.removed.length <= content.length
    && content.slice(edit.at, edit.at + edit.removed.length) === edit.removed;
  if (!valid) throw new HostConfigError('host_config_invalid_state', `${file}: the ${request.selector} strategy returned an edit that does not match the content`);
}

/**
 * Plan one file: the edits apply in request order, each computed against the
 * content after the earlier ones, so a container that one fragment creates is
 * there for the next. Nothing here reads or writes a file.
 */
export function planFile(
  file: string,
  content: string,
  requests: readonly FragmentRequest[],
  ledgerFragments: readonly FragmentRecord[],
): FilePlan {
  const skipped: SkippedOverride[] = [];
  const applied = requests.filter((request) => {
    if (request.kind !== 'override' || request.selected === true) return true;
    skipped.push({ code: 'host_config_override_skipped', file, owner: request.owner, selector: request.selector });
    return false;
  });
  const active = ledgerFragments.filter((record) => record.file === file);
  checkSelectors(file, applied, active);

  const planned: { request: FragmentRequest; edit: FragmentEdit; previous: FragmentRecord | null; created: string | null }[] = [];
  let result = content;
  for (const request of applied) {
    const edit = request.strategy.apply(result, request.selector, request.value);
    // An edit whose text is already in place still claims its fragment, so the ledger records the owner.
    checkEdit(file, result, request, edit);
    const previous = active.find((record) => record.owner === request.owner && record.selector === request.selector) ?? null;
    // A refresh of text that rh never recorded would overwrite a user's value: it is an override.
    if (request.kind === 'refresh' && !previous && request.selected !== true) {
      skipped.push({ code: 'host_config_override_skipped', file, owner: request.owner, selector: request.selector });
      continue;
    }
    // The text at a recorded selector is no longer rh's: the user's value stays unless the plan input selects the edit.
    if (previous && edit.removed !== previous.inserted && request.selected !== true) {
      skipped.push({ code: 'host_config_user_value_kept', file, owner: request.owner, selector: request.selector });
      continue;
    }
    const created = request.strategy.created?.(result, request.selector) ?? null;
    result = result.slice(0, edit.at) + edit.inserted + result.slice(edit.at + edit.removed.length);
    planned.push({ request, edit, previous, created });
  }

  const fragments = planned.map(({ request, edit, previous, created }): PlannedFragment => {
    const range = request.strategy.locate(result, request.selector);
    return { owner: request.owner, selector: request.selector, kind: request.kind, edit, previous, text: range ? result.slice(range.start, range.end) : '', created };
  });
  return { file, result, fragments, skipped };
}
