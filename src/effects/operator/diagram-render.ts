// The optional render capability for docs diagrams (G39). Its library, fonts and
// icons live in one directory under the harness home and never in the core
// package. `renderDiagramPass` is the one render entry: a one-shot child with a
// deadline draws one document, and the parent ends the child's process group and
// the browser's own group, then deletes the child's scratch directory.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../../core/evidence/sha256';
import type { DocsDiagramFailure, DocsDiagramIssueV1 } from '../../core/operator/docs';
import { repoHarnessHome } from '../repo-harness-home';
import { terminateProcessGroup } from '../process-group-termination';
import { runSetupProcess, type SetupProcessRunner } from '../setup/collector';

/** The only library version the capability accepts. */
export const RENDER_LIBRARY_VERSION = '0.5.2';
export const RENDER_DEADLINE_MS = 60_000;
export const RENDER_CHILD_ENTRY = fileURLToPath(new URL('./diagram-render-worker.ts', import.meta.url));

export const renderCapabilityDir = (env: NodeJS.ProcessEnv): string => join(repoHarnessHome(env), 'operator', 'render-capability');
export const diagramArtifactDir = (env: NodeJS.ProcessEnv): string => join(repoHarnessHome(env), 'operator', 'docs-diagrams');

export type RenderCapability =
  | { readonly state: 'ready'; readonly directory: string; readonly browser: string; readonly fingerprint: string }
  | { readonly state: 'unavailable'; readonly reason: 'capability_missing' | 'browser_missing' };

function browserCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  const configured = env.REPO_HARNESS_RENDER_BROWSER;
  if (configured) return [configured];
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (process.platform === 'win32') {
    return [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
      .flatMap(root => (root ? [join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []));
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
}

/** Files of one capability folder as `name:size:mtime`, so a changed font or icon set changes the fingerprint. */
function folderFacts(directory: string): string[] {
  try {
    return readdirSync(directory).sort().map(name => { const stat = statSync(join(directory, name)); return `${name}:${stat.size}:${stat.mtimeMs}`; });
  } catch { return []; }
}

/** Reads the installation on disk. It starts no process. */
export function probeRenderCapability(env: NodeJS.ProcessEnv): RenderCapability {
  const directory = renderCapabilityDir(env);
  let version: unknown;
  try { version = (JSON.parse(readFileSync(join(directory, 'node_modules', '@eraserlabs', 'diagrams', 'package.json'), 'utf8')) as { version?: unknown }).version; }
  catch { return { state: 'unavailable', reason: 'capability_missing' }; }
  if (version !== RENDER_LIBRARY_VERSION) return { state: 'unavailable', reason: 'capability_missing' };
  const browser = browserCandidates(env).find(path => existsSync(path));
  if (browser === undefined) return { state: 'unavailable', reason: 'browser_missing' };
  const fingerprint = sha256Hex(JSON.stringify({ library: version, fonts: folderFacts(join(directory, 'fonts')), icons: folderFacts(join(directory, 'icons')) }));
  return { state: 'ready', directory, browser, fingerprint };
}

export interface RenderOutputs { readonly svg: boolean; readonly png: boolean }
export type RenderPassResult =
  | { readonly ok: true; readonly svg: string | null; readonly png: Buffer | null }
  | { readonly ok: false; readonly kind: 'invalid'; readonly issues: readonly DocsDiagramIssueV1[] }
  | { readonly ok: false; readonly kind: 'failed'; readonly reason: DocsDiagramFailure };

export interface RenderPassOptions {
  readonly capability: Extract<RenderCapability, { state: 'ready' }>;
  /** A parsed Eraser JSON document; the library validates it. */
  readonly document: unknown;
  readonly outputs: RenderOutputs;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly deadline_ms?: number;
  readonly run_process?: SetupProcessRunner;
}

const FAILURES: readonly unknown[] = ['timeout', 'resource_missing', 'render_failed'];

/** The child's result file, checked once here; any other shape is a failed render. */
function decodeResult(text: string): RenderPassResult {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.ok === true) {
    const { svg, png } = value;
    if ((svg !== null && typeof svg !== 'string') || (png !== null && typeof png !== 'string')) throw new Error('result outputs');
    return { ok: true, svg, png: png === null ? null : Buffer.from(png as string, 'base64') };
  }
  if (value.kind === 'invalid' && Array.isArray(value.issues)) {
    const issues = value.issues.slice(0, 100).map((raw: Record<string, unknown>) => ({ element: String(raw.element), field: String(raw.field), fix: String(raw.fix) }));
    return { ok: false, kind: 'invalid', issues };
  }
  if (value.kind === 'failed' && FAILURES.includes(value.reason)) return { ok: false, kind: 'failed', reason: value.reason as DocsDiagramFailure };
  throw new Error('result shape');
}

/**
 * Draws one document in a one-shot child. A deadline, an abort or a crash ends the
 * child's group and the browser's group; the scratch directory never outlives the call.
 */
export async function renderDiagramPass(options: RenderPassOptions): Promise<RenderPassResult> {
  const job = mkdtempSync(join(tmpdir(), 'repo-harness-diagram-'));
  try {
    mkdirSync(join(job, 'tmp'));
    writeFileSync(join(job, 'input.json'), JSON.stringify({ document: options.document, outputs: options.outputs }), { mode: 0o600 });
    const run = options.run_process ?? runSetupProcess;
    const result = await run([RENDER_CHILD_ENTRY, options.capability.directory, options.capability.browser, job], {
      cwd: options.capability.directory, service: 'diagram-render', signal: options.signal, timeout_ms: options.deadline_ms ?? RENDER_DEADLINE_MS,
      // The browser reads TMPDIR for its profile; it dies with the job directory.
      env: { PATH: options.env.PATH, HOME: options.env.HOME, USERPROFILE: options.env.USERPROFILE, TMPDIR: join(job, 'tmp'), TEMP: join(job, 'tmp'), TMP: join(job, 'tmp') },
    });
    // The browser leads its own process group on POSIX, so ending the child leaves it running.
    try {
      const pid = Number(readFileSync(join(job, 'browser.pid'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 1) await terminateProcessGroup(pid, 200);
    } catch { /* the child never started a browser */ }
    if (!result.ok) return { ok: false, kind: 'failed', reason: result.code === 'timeout' ? 'timeout' : 'render_failed' };
    try { return decodeResult(readFileSync(join(job, 'result.json'), 'utf8')); }
    catch { return { ok: false, kind: 'failed', reason: 'render_failed' }; }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

/** What the store keeps for one hash. The image, when there is one, is `<hash>.svg` beside it. */
export type StoredDiagram =
  | { readonly status: 'ok'; readonly fingerprint: string }
  | { readonly status: 'invalid'; readonly fingerprint: string; readonly issues: readonly DocsDiagramIssueV1[] }
  | { readonly status: 'failed'; readonly fingerprint: string; readonly reason: DocsDiagramFailure };

const HASH = /^[0-9a-f]{64}$/u;

/** A cache of values that can be computed again; the documents stay the authority. */
export function readStoredDiagram(env: NodeJS.ProcessEnv, hash: string): StoredDiagram | null {
  if (!HASH.test(hash)) return null;
  try {
    const value = JSON.parse(readFileSync(join(diagramArtifactDir(env), `${hash}.json`), 'utf8')) as Record<string, unknown>;
    if (typeof value.fingerprint !== 'string') return null;
    if (value.status === 'ok') return { status: 'ok', fingerprint: value.fingerprint };
    if (value.status === 'invalid' && Array.isArray(value.issues)) return value as unknown as StoredDiagram;
    if (value.status === 'failed' && FAILURES.includes(value.reason)) return value as unknown as StoredDiagram;
    return null;
  } catch { return null; }
}

export function readDiagramImage(env: NodeJS.ProcessEnv, hash: string): Buffer | null {
  if (!HASH.test(hash)) return null;
  try { return readFileSync(join(diagramArtifactDir(env), `${hash}.svg`)); } catch { return null; }
}

function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

/** The image is written before its record, so a record `ok` always has an image. */
export function storeDiagram(env: NodeJS.ProcessEnv, hash: string, record: StoredDiagram, svg: string | null): void {
  const directory = diagramArtifactDir(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (svg !== null) atomicWrite(join(directory, `${hash}.svg`), svg);
  atomicWrite(join(directory, `${hash}.json`), JSON.stringify(record));
}
