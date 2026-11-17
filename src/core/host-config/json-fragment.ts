import { isRepoHarnessManagedHookCommand } from '../adoption/managed-hook-config';
import { HostConfigError, type FragmentEdit, type HostConfigStrategy, type TextRange } from './types';

/**
 * Text edits in a JSON host file (`~/.claude/settings.json`,
 * `~/.codex/hooks.json`, `~/.claude.json`). The file is never re-serialized:
 * an edit inserts or removes text at a position, in the file's own indent,
 * and the bytes outside it stay.
 *
 * Selectors: a member path (`statusLine`, `mcpServers.codegraph`), or a
 * member path to an array plus one element in brackets. `[<text>]` is the
 * string element with that value; in a `hooks.<Event>` array, `[<routeId>]`
 * is the hook entry whose one command is rh's managed command of that route.
 */

type JsonNode =
  | { readonly type: 'object'; readonly start: number; readonly end: number; readonly members: readonly JsonMember[] }
  | { readonly type: 'array'; readonly start: number; readonly end: number; readonly elements: readonly JsonNode[] }
  | { readonly type: 'scalar'; readonly start: number; readonly end: number };

interface JsonMember {
  readonly key: string;
  readonly start: number;
  readonly value: JsonNode;
}

type Container = Extract<JsonNode, { type: 'object' | 'array' }>;

/** One item of a container: its text range, and the container that holds it. */
interface Located {
  readonly range: TextRange;
  readonly container: Container;
  readonly index: number;
  readonly parentPath: readonly string[];
}

function unparseable(detail: string): HostConfigError {
  return new HostConfigError('host_config_unparseable_target', `${detail}; rh writes nothing to it`);
}

function invalid(detail: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', detail);
}

/** Positions of an input that `JSON.parse` already accepted. */
function scan(content: string): JsonNode {
  let at = 0;
  const space = () => { while (/\s/.test(content[at] ?? '')) at += 1; };
  const string = (): string => {
    const start = at;
    at += 1;
    while (content[at] !== '"') at += content[at] === '\\' ? 2 : 1;
    at += 1;
    return JSON.parse(content.slice(start, at)) as string;
  };
  const value = (): JsonNode => {
    space();
    const start = at;
    if (content[at] === '{') {
      at += 1;
      const members: JsonMember[] = [];
      space();
      while (content[at] !== '}') {
        const memberStart = at;
        const key = string();
        space();
        at += 1;
        members.push({ key, start: memberStart, value: value() });
        space();
        if (content[at] === ',') { at += 1; space(); }
      }
      at += 1;
      return { type: 'object', start, end: at, members };
    }
    if (content[at] === '[') {
      at += 1;
      const elements: JsonNode[] = [];
      space();
      while (content[at] !== ']') {
        elements.push(value());
        space();
        if (content[at] === ',') { at += 1; space(); }
      }
      at += 1;
      return { type: 'array', start, end: at, elements };
    }
    if (content[at] === '"') { string(); return { type: 'scalar', start, end: at }; }
    while (at < content.length && !/[\s,\]}]/.test(content[at]!)) at += 1;
    return { type: 'scalar', start, end: at };
  };
  return value();
}

function root(content: string): Extract<JsonNode, { type: 'object' }> | null {
  if (content.trim() === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw unparseable('the file is not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw unparseable('the file is not a JSON object');
  return scan(content) as Extract<JsonNode, { type: 'object' }>;
}

interface Selector {
  readonly path: readonly string[];
  readonly element: string | null;
}

function parseSelector(selector: string): Selector {
  const segments = selector.split('.');
  const last = /^([^[\]]+)(?:\[([^[\]]+)\])?$/.exec(segments.at(-1) ?? '');
  if (!last || segments.slice(0, -1).some((segment) => !/^[^[\]]+$/.test(segment))) throw invalid(`not a JSON fragment selector: ${selector}`);
  return { path: [...segments.slice(0, -1), last[1]!], element: last[2] ?? null };
}

const ROUTE_COMMAND = / (\S+) --route (\S+)$/;

/**
 * The managed route commands of one hook entry, as `<event> <routeId>`;
 * `others` counts every other command, `user` only those that are not rh's.
 */
function managedRoutes(entry: unknown): { routes: string[]; others: number; user: number } {
  const hooks = (entry as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) return { routes: [], others: 0, user: 0 };
  const routes: string[] = [];
  let others = 0, user = 0;
  for (const hook of hooks) {
    const command = (hook as { command?: unknown } | null)?.command;
    const managed = isRepoHarnessManagedHookCommand(command);
    const route = managed ? ROUTE_COMMAND.exec(command) : null;
    if (route) routes.push(`${route[1]} ${route[2]}`); else others += 1;
    if (!managed) user += 1;
  }
  return { routes, others, user };
}

function elementMatches(content: string, node: JsonNode, key: string, event: string): boolean {
  const value = JSON.parse(content.slice(node.start, node.end)) as unknown;
  if (typeof value === 'string') return value === key;
  const { routes, others } = managedRoutes(value);
  if (!routes.includes(`${event} ${key}`)) return false;
  if (routes.length !== 1 || others !== 0) {
    throw invalid(`a hook entry in ${event} holds the repo-harness ${key} command together with other commands. Move that command into its own entry, or delete it, then run rh again`);
  }
  return true;
}

function memberNode(container: JsonNode, key: string): JsonMember | null {
  if (container.type !== 'object') return null;
  const found = container.members.filter((member) => member.key === key);
  if (found.length > 1) throw unparseable(`the key ${JSON.stringify(key)} is set twice`);
  return found[0] ?? null;
}

/** Walk the member path; `depth` is how many segments exist. */
function walk(document: Container, path: readonly string[]): { node: JsonNode; depth: number; member: JsonMember | null; parent: Container } {
  let node: JsonNode = document, parent: Container = document, member: JsonMember | null = null;
  for (const [depth, key] of path.entries()) {
    const next = memberNode(node, key);
    if (!next) return { node, depth, member, parent };
    if (node.type !== 'scalar') parent = node;
    member = next;
    node = next.value;
  }
  return { node, depth: path.length, member, parent };
}

function find(content: string, selector: string): Located | null {
  const document = root(content);
  if (!document) return null;
  const { path, element } = parseSelector(selector);
  const walked = walk(document, path);
  if (walked.depth < path.length) return null;
  if (element === null) {
    const member = walked.member!;
    const index = (walked.parent as Extract<JsonNode, { type: 'object' }>).members.indexOf(member);
    return { range: { start: member.start, end: member.value.end }, container: walked.parent, index, parentPath: path.slice(0, -1) };
  }
  if (walked.node.type !== 'array') return null;
  const array = walked.node;
  const matches = array.elements.filter((node) => elementMatches(content, node, element, path.at(-1)!));
  if (matches.length > 1) throw invalid(`${selector} is in the file ${matches.length} times. Delete the extra copies, then run rh again`);
  if (!matches.length) return null;
  const index = array.elements.indexOf(matches[0]!);
  return { range: { start: matches[0]!.start, end: matches[0]!.end }, container: array, index, parentPath: path };
}

function items(container: Container): readonly { start: number; end: number }[] {
  return container.type === 'object' ? container.members.map((member) => ({ start: member.start, end: member.value.end })) : container.elements;
}

function lineIndent(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(content.slice(lineStart))![0];
}

/** The file's indent unit; a one-line object is compact. */
function layout(content: string, document: Container | null): { compact: boolean; unit: string } {
  if (document && !content.slice(document.start, document.end).includes('\n')) return { compact: true, unit: '' };
  return { compact: false, unit: /^([ \t]+)["{[\]}]/m.exec(content)?.[1] ?? '  ' };
}

function render(value: unknown, compact: boolean, unit: string, indent: string): string {
  return compact ? JSON.stringify(value) : JSON.stringify(value, null, unit).replaceAll('\n', `\n${indent}`);
}

/** The indent of the items in a container, from an existing item or one unit deeper than the container line. */
function childIndent(content: string, container: Container, unit: string): string {
  const first = items(container)[0];
  if (first && /^[ \t]*$/.test(content.slice(content.lastIndexOf('\n', first.start - 1) + 1, first.start))) return lineIndent(content, first.start);
  return lineIndent(content, container.start) + unit;
}

function isHookEntry(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Array.isArray((value as { hooks?: unknown }).hooks);
}

/** A hook entry goes after the managed entries at the front of its array, so rh's entries stay before the user's. */
function insertIndex(content: string, container: Container, value: unknown): number {
  const all = items(container);
  if (container.type !== 'array' || !isHookEntry(value)) return all.length;
  let index = 0;
  while (index < all.length && managedRoutes(JSON.parse(content.slice(all[index]!.start, all[index]!.end))).routes.length) index += 1;
  return index;
}

function insertEdit(content: string, container: Container, index: number, text: string, compact: boolean, unit: string): FragmentEdit {
  const all = items(container);
  if (compact) {
    if (!all.length) return { at: container.start + 1, removed: '', inserted: text };
    return index === 0 ? { at: all[0]!.start, removed: '', inserted: `${text},` } : { at: all[index - 1]!.end, removed: '', inserted: `,${text}` };
  }
  const child = childIndent(content, container, unit);
  if (!all.length) {
    const interior = content.slice(container.start + 1, container.end - 1);
    return { at: container.start + 1, removed: '', inserted: `\n${child}${text}${interior.includes('\n') ? '' : `\n${lineIndent(content, container.start)}`}` };
  }
  return index === 0 ? { at: all[0]!.start, removed: '', inserted: `${text},\n${child}` } : { at: all[index - 1]!.end, removed: '', inserted: `,\n${child}${text}` };
}

/** The value that the missing part of the path holds: `{ "b": [value] }` for `a.b[x]` when only `a` exists. */
function nest(path: readonly string[], element: string | null, value: unknown): unknown {
  let nested = element === null ? value : [value];
  for (const key of [...path].reverse()) nested = { [key]: nested };
  return nested;
}

function setFragment(content: string, selector: string, value: unknown): FragmentEdit {
  const document = root(content);
  const { compact, unit } = layout(content, document);
  const { path, element } = parseSelector(selector);
  if (!document) return { at: 0, removed: '', inserted: `${render(nest(path, element, value), compact, unit, '')}\n` };
  const located = find(content, selector);
  if (located) {
    const indent = lineIndent(content, located.range.start);
    const text = element === null ? `${JSON.stringify(path.at(-1))}:${compact ? '' : ' '}${render(value, compact, unit, indent)}` : render(value, compact, unit, indent);
    return { at: located.range.start, removed: content.slice(located.range.start, located.range.end), inserted: text };
  }
  // The deepest existing node takes the missing rest: an object takes a member, an array takes the element.
  const { node: target, depth } = walk(document, path);
  const rest = path.slice(depth);
  if (rest.length ? target.type !== 'object' : target.type !== 'array') throw invalid(`${selector}: ${path.slice(0, depth).join('.') || 'the file'} is not a container that rh can add to`);
  const container = target as Container;
  const indent = childIndent(content, container, unit);
  const added = rest.length ? nest(rest.slice(1), element, value) : value;
  const text = rest.length ? `${JSON.stringify(rest[0])}:${compact ? '' : ' '}${render(added, compact, unit, indent)}` : render(value, compact, unit, indent);
  return insertEdit(content, container, insertIndex(content, container, added), text, compact, unit);
}

/** The member path of the container that holds the fragment at a selector: the array of an element, the object of a member. */
function containerPath(selector: string): readonly string[] {
  const { path, element } = parseSelector(selector);
  return element === null ? path.slice(0, -1) : path;
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => key === path[index]);
}

/**
 * The outermost container on the selector's path that is not in the content
 * yet, so that an insert at the selector creates it; null when the fragment's
 * container is already there. The root object is not one of them.
 */
function createdJsonContainer(content: string, selector: string): string | null {
  const containers = containerPath(selector);
  if (!containers.length) return null;
  const document = root(content);
  const depth = document ? walk(document, containers).depth : 0;
  return depth < containers.length ? containers.slice(0, depth + 1).join('.') : null;
}

/** A fragment record that may prove a container: rh's insert at `selector` created `created` and every container below it. */
export interface CreatedContainerRecord {
  readonly selector: string;
  readonly created?: string;
}

/**
 * Takes the fragment out with its separator. A container that the removal
 * empties goes too, but only when a record proves that rh's insert created
 * it; any other container stays, empty.
 */
export function removeJsonFragment(content: string, selector: string, records: readonly CreatedContainerRecord[] = []): FragmentEdit {
  const located = find(content, selector);
  if (!located) return { at: 0, removed: '', inserted: '' };
  const { container, index, parentPath } = located;
  const all = items(container);
  if (all.length === 1) {
    const created = parentPath.length > 0 && records.some((record) => record.created !== undefined
      && isPrefix(record.created.split('.'), parentPath) && isPrefix(parentPath, containerPath(record.selector)));
    if (created) return removeJsonFragment(content, parentPath.join('.'), records);
    return { at: container.start + 1, removed: content.slice(container.start + 1, container.end - 1), inserted: '' };
  }
  const [start, end] = index < all.length - 1 ? [all[index]!.start, all[index + 1]!.start] : [all[index - 1]!.end, all[index]!.end];
  return { at: start, removed: content.slice(start, end), inserted: '' };
}

export function jsonDocumentIsEmpty(content: string): boolean {
  return /^\s*(?:\{\s*\}\s*)?$/.test(content);
}

/** The JSON value at a selector, or undefined when the file does not set it. */
export function jsonFragmentValue(content: string, selector: string): unknown {
  const located = find(content, selector);
  if (!located) return undefined;
  const text = content.slice(located.range.start, located.range.end);
  const { path, element } = parseSelector(selector);
  return element === null ? (JSON.parse(`{${text}}`) as Record<string, unknown>)[path.at(-1)!] : JSON.parse(text) as unknown;
}

/**
 * The selectors of rh's managed hook entries in a hook file. A managed command
 * that shares its entry with another command has no selector of its own, so
 * it fails closed with the step that frees it.
 */
export function managedHookSelectors(content: string): string[] {
  const hooks = root(content) === null ? undefined : (JSON.parse(content) as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const selectors: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const { routes, others, user } = managedRoutes(entry);
      // Any rh command beside a user's command makes the entry mixed, also a retired one with no route.
      const mixed = user !== 0 && routes.length + others > user;
      if (!routes.length && !mixed) continue;
      if (mixed || routes.length !== 1 || others !== 0) {
        throw invalid(`a hook entry in ${event} holds a repo-harness command together with other commands. Move that command into its own entry, or delete it, then run rh again`);
      }
      const [routeEvent, routeId] = routes[0]!.split(' ');
      if (routeEvent === event) selectors.push(`hooks.${event}[${routeId}]`);
    }
  }
  // Each selector must locate one entry; a duplicate fails closed here.
  for (const selector of selectors) find(content, selector);
  return [...new Set(selectors)];
}

/** Sets the value at a selector; `undefined` is not a value. */
export const jsonFragment: HostConfigStrategy<unknown> = {
  locate: (content, selector) => find(content, selector)?.range ?? null,
  created: createdJsonContainer,
  apply(content, selector, value) {
    if (value === undefined) throw invalid(`${selector}: no value to write`);
    return setFragment(content, selector, value);
  },
};
