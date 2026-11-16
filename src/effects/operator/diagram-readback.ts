// Agent readback of one diagram (G39): one command draws the document in one render
// pass, the same pass that gives the docs page its SVG, and returns the PNG path or the
// errors. The PNG is for the agent. It lives outside the docs artifact store.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { diagramSourceIssues, type DocsDiagramFailure, type DocsDiagramIssueV1 } from '../../core/operator/docs';
import { repoHarnessHome } from '../repo-harness-home';
import { diagramHash } from './diagram-renderer';
import { probeRenderCapability, renderDiagramPass, type RenderPassOptions, type RenderPassResult } from './diagram-render';

export type DiagramReadback =
  | { readonly ok: true; readonly hash: string; readonly png: string }
  | { readonly ok: false; readonly status: 'invalid'; readonly issues: readonly DocsDiagramIssueV1[] }
  | { readonly ok: false; readonly status: 'failed'; readonly reason: DocsDiagramFailure }
  | { readonly ok: false; readonly status: 'unavailable'; readonly reason: 'capability_missing' | 'browser_missing'; readonly message: string };

/** Exit codes follow the library CLI: 1 when the input fails, 2 when the invocation cannot run. */
export const readbackExitCode = (result: DiagramReadback): number => (result.ok ? 0 : result.status === 'unavailable' ? 2 : 1);

export const readbackDirectory = (env: NodeJS.ProcessEnv): string => join(repoHarnessHome(env), 'operator', 'readback');

export async function readbackDiagram(
  text: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal; readonly render?: (options: RenderPassOptions) => Promise<RenderPassResult> },
): Promise<DiagramReadback> {
  // The same source validation as the docs page: syntax, depth and remote icon addresses.
  const source = diagramSourceIssues(text);
  if (source.issues.length > 0) return { ok: false, status: 'invalid', issues: source.issues };
  const document = source.document;
  const capability = probeRenderCapability(options.env);
  if (capability.state !== 'ready') return { ok: false, status: 'unavailable', reason: capability.reason, message: capability.reason === 'capability_missing' ? 'render capability not installed' : 'render browser not found' };
  const drawn = await (options.render ?? renderDiagramPass)({ capability, document, outputs: { svg: true, png: true }, env: options.env, signal: options.signal });
  if (!drawn.ok) return drawn.kind === 'invalid' ? { ok: false, status: 'invalid', issues: drawn.issues } : { ok: false, status: 'failed', reason: drawn.reason };
  if (drawn.png === null) return { ok: false, status: 'failed', reason: 'render_failed' };
  const hash = diagramHash(document);
  const directory = readbackDirectory(options.env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const png = join(directory, `${hash}.png`);
  writeFileSync(png, drawn.png, { mode: 0o600 });
  return { ok: true, hash, png };
}
