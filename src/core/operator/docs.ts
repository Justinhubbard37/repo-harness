// Public contract of the docs routes (PRD G7). The tree comes from the docs
// collector's cache; a file comes from one object of the collector's resident
// cat-file process. Both name the ref and the commit they were read from.
// The strict decoders serve the server before it sends and the browser before
// it renders.

import { GITHUB_REPOSITORY } from '../board/github-repository';

export const OPERATOR_DOCS_TREE_KIND = 'operator_docs_tree' as const;
export const OPERATOR_DOCS_FILE_KIND = 'operator_docs_file' as const;

/** Why a repository's docs cannot be served. Each maps to one HTTP status in the route. */
export const DOCS_UNAVAILABLE_REASONS = [
  'docs_pending',
  'registry_unavailable',
  'repository_not_found',
  'default_branch_unknown',
  'github_remote_missing',
  'github_remote_ambiguous',
  'branch_missing',
  'ref_invalid',
  'docs_too_large',
  'docs_reader_unavailable',
] as const;
export type DocsUnavailableReason = typeof DOCS_UNAVAILABLE_REASONS[number];

/** What the collector compared when no git remote points to the GitHub repository (`github_remote_missing`). */
export interface DocsRemoteMismatchV1 {
  /** The GitHub repository Dev Activity named, `owner/name`. */
  readonly github: string;
  /**
   * The GitHub repositories, `owner/name`, parsed from the local remote URLs; a URL that is not a GitHub URL adds none.
   * No remote name and no URL text: both are git config text, and a URL can hold a credential.
   */
  readonly remote_repositories: readonly string[];
}

export interface DocsTreeV1 {
  readonly protocol: 1;
  readonly kind: typeof OPERATOR_DOCS_TREE_KIND;
  readonly repository_id: string;
  /** The ref the collector read, for example `refs/remotes/origin/main`. */
  readonly ref: string;
  readonly commit: string;
  /** When the collector built this listing. */
  readonly collected_at: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
}

export interface DocsFileV1 {
  readonly protocol: 1;
  readonly kind: typeof OPERATOR_DOCS_FILE_KIND;
  readonly repository_id: string;
  readonly ref: string;
  readonly commit: string;
  /** The committer date of `commit`, read from its commit object, in UTC. */
  readonly committed_at: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly text: string;
  readonly lines: readonly DocsLine[];
  /** The worktree copy is missing, is not the same regular file, or has other bytes. */
  readonly worktree_differs: boolean;
}

export interface DocsLine {
  readonly number: number;
  /** Original text, including its LF or CRLF terminator when present. */
  readonly text: string;
}

/** One-based source lines. Empty files have no lines; a final LF adds no phantom line. */
export function docsLines(text: string): DocsLine[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line, index) => ({ number: index + 1, text: line }));
}

const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DOCS_REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]{1,255}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
// No control byte or backslash; `docs/` first; no empty, `.` or `..` segment.
const DOCS_PATH = /^docs\/[^\x00-\x1f\x7f\\]{1,4091}$/u;

type Json = Record<string, unknown>;

function decoder(label: string) {
  const fail = (what: string): never => { throw new Error(`${label} invalid: ${what}`); };
  return {
    fail,
    obj: (v: unknown, keys: readonly string[], what: string): Json => {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) return fail(what);
      return v as Json;
    },
    match: (v: unknown, pattern: RegExp, what: string): string => (typeof v === 'string' && pattern.test(v) ? v : fail(what)),
    count: (v: unknown, what: string): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail(what)),
    path: (v: unknown): string => {
      if (typeof v !== 'string' || !DOCS_PATH.test(v) || v.split('/').some(part => !part || part === '.' || part === '..')) return fail('path');
      return v;
    },
  };
}

export function decodeDocsRemoteMismatch(value: unknown): DocsRemoteMismatchV1 {
  const d = decoder('docs remote mismatch');
  const v = d.obj(value, ['github', 'remote_repositories'], 'detail');
  d.match(v.github, GITHUB_REPOSITORY, 'github');
  if (!Array.isArray(v.remote_repositories)) d.fail('remote_repositories');
  for (const repository of v.remote_repositories as unknown[]) d.match(repository, GITHUB_REPOSITORY, 'remote repository');
  return value as DocsRemoteMismatchV1;
}

export function decodeDocsTree(value: unknown): DocsTreeV1 {
  const d = decoder('docs tree');
  const v = d.obj(value, ['protocol', 'kind', 'repository_id', 'ref', 'commit', 'collected_at', 'files'], 'tree');
  if (v.protocol !== 1 || v.kind !== OPERATOR_DOCS_TREE_KIND) d.fail('protocol');
  d.match(v.repository_id, REPOSITORY_ID, 'repository_id');
  d.match(v.ref, DOCS_REF, 'ref');
  d.match(v.commit, COMMIT, 'commit');
  d.match(v.collected_at, ISO_TIME, 'collected_at');
  if (!Array.isArray(v.files)) d.fail('files');
  const seen = new Set<string>();
  for (const raw of v.files as unknown[]) {
    const file = d.obj(raw, ['path', 'size', 'sha256'], 'file');
    const path = d.path(file.path);
    if (seen.has(path)) d.fail('duplicate path');
    seen.add(path);
    d.count(file.size, 'size');
    d.match(file.sha256, SHA256, 'sha256');
  }
  return value as DocsTreeV1;
}

export function decodeDocsFile(value: unknown): DocsFileV1 {
  const d = decoder('docs file');
  const v = d.obj(value, ['protocol', 'kind', 'repository_id', 'ref', 'commit', 'committed_at', 'path', 'size', 'sha256', 'text', 'lines', 'worktree_differs'], 'file');
  if (v.protocol !== 1 || v.kind !== OPERATOR_DOCS_FILE_KIND) d.fail('protocol');
  d.match(v.repository_id, REPOSITORY_ID, 'repository_id');
  d.match(v.ref, DOCS_REF, 'ref');
  d.match(v.commit, COMMIT, 'commit');
  d.match(v.committed_at, ISO_TIME, 'committed_at');
  d.path(v.path);
  d.count(v.size, 'size');
  d.match(v.sha256, SHA256, 'sha256');
  if (typeof v.text !== 'string') d.fail('text');
  const lines = docsLines(v.text as string);
  if (!Array.isArray(v.lines) || v.lines.length !== lines.length) d.fail('lines');
  for (const [index, raw] of (v.lines as unknown[]).entries()) {
    const line = d.obj(raw, ['number', 'text'], 'line');
    if (line.number !== lines[index].number || line.text !== lines[index].text) d.fail('line');
  }
  if (typeof v.worktree_differs !== 'boolean') d.fail('worktree_differs');
  return value as DocsFileV1;
}

export const OPERATOR_DOCS_DIAGRAM_KIND = 'operator_docs_diagram' as const;
/** Why the render of one diagram block failed. */
export const DOCS_DIAGRAM_FAILURES = ['timeout', 'resource_missing', 'render_failed'] as const;
export type DocsDiagramFailure = typeof DOCS_DIAGRAM_FAILURES[number];
export const DOCS_DIAGRAM_STATES = ['rendered', 'stale', 'pending', 'invalid', 'failed', 'capability_missing', 'browser_missing'] as const;
export type DocsDiagramState = typeof DOCS_DIAGRAM_STATES[number];

export interface DocsDiagramIssueV1 { readonly element: string; readonly field: string; readonly fix: string }
/**
 * The state of one diagram block, named by the sha256 of `JSON.stringify` of its parsed
 * document. `rendered` and `stale` have an image under the same hash; `stale` was drawn
 * with another library, font or icon set than the installed one.
 */
export interface DocsDiagramV1 {
  readonly protocol: 1;
  readonly kind: typeof OPERATOR_DOCS_DIAGRAM_KIND;
  readonly hash: string;
  readonly state: DocsDiagramState;
  /** Only `invalid` lists issues. */
  readonly issues: readonly DocsDiagramIssueV1[];
  /** Only `failed` names a reason. */
  readonly reason: DocsDiagramFailure | null;
}

export function decodeDocsDiagram(value: unknown): DocsDiagramV1 {
  const d = decoder('docs diagram');
  const v = d.obj(value, ['protocol', 'kind', 'hash', 'state', 'issues', 'reason'], 'diagram');
  if (v.protocol !== 1 || v.kind !== OPERATOR_DOCS_DIAGRAM_KIND) d.fail('protocol');
  d.match(v.hash, SHA256, 'hash');
  if (!(DOCS_DIAGRAM_STATES as readonly unknown[]).includes(v.state)) d.fail('state');
  if (!Array.isArray(v.issues) || (v.state !== 'invalid' && v.issues.length > 0) || v.issues.length > 100) d.fail('issues');
  for (const raw of v.issues as unknown[]) {
    const issue = d.obj(raw, ['element', 'field', 'fix'], 'issue');
    for (const key of ['element', 'field', 'fix']) if (typeof issue[key] !== 'string' || (issue[key] as string).length > 1000) d.fail(`issue ${key}`);
  }
  if (v.state === 'failed' ? !(DOCS_DIAGRAM_FAILURES as readonly unknown[]).includes(v.reason) : v.reason !== null) d.fail('reason');
  return value as DocsDiagramV1;
}

/** Eraser documents are a few levels deep; a block nested deeper than this is refused before it is hashed, serialized or drawn. */
export const DIAGRAM_MAX_DEPTH = 64;

/** Iterative, so the check itself cannot overflow the stack on a hostile block. */
export function diagramTooDeep(document: unknown): boolean {
  const stack: Array<readonly [unknown, number]> = [[document, 1]];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    const [value, depth] = step;
    if (value === null || typeof value !== 'object') continue;
    if (depth > DIAGRAM_MAX_DEPTH) return true;
    for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}

const REMOTE_ADDRESS = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/**
 * Errors the core owns before the capability sees the block: a JSON syntax error, and a
 * remote or scheme-bearing `icon` address (the only resource field; icons load from a local set).
 */
export function diagramSourceIssues(source: string): { readonly document: unknown; readonly issues: readonly DocsDiagramIssueV1[] } {
  let document: unknown;
  try { document = JSON.parse(source); } catch (error) {
    return { document: null, issues: [{ element: 'block', field: 'JSON', fix: `Fix the JSON syntax: ${error instanceof Error ? error.message : 'the text does not parse'}.` }] };
  }
  if (diagramTooDeep(document)) {
    return { document, issues: [{ element: 'block', field: 'depth', fix: `Nest the JSON at most ${DIAGRAM_MAX_DEPTH} levels deep.` }] };
  }
  const issues: DocsDiagramIssueV1[] = [];
  // Iterative: a deeply nested block must not overflow the call stack. A pointer is built only for an issue.
  interface Step { readonly value: unknown; readonly parent: Step | null; readonly key: string }
  const pointerOf = (step: Step | null): string => {
    const keys: string[] = [];
    for (let at = step; at !== null && at.parent !== null; at = at.parent) keys.push(at.key);
    return keys.length === 0 ? '/' : `/${keys.reverse().join('/')}`;
  };
  const stack: Step[] = [{ value: document, parent: null, key: '' }];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    const { value } = step;
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'icon' && typeof child === 'string' && REMOTE_ADDRESS.test(child)) {
        issues.push({ element: pointerOf(step), field: 'icon', fix: 'Use the name of a local icon; a remote address is not allowed.' });
      } else stack.push({ value: child, parent: step, key });
    }
  }
  return { document, issues };
}
