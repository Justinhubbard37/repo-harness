// Background renderer of docs diagrams (G39). Each cycle probes the optional render
// capability, finds the `eraser-diagram` blocks of each docs file whose blob changed,
// and draws a block when no current artifact exists for its content hash. A request for
// a document reads the artifacts and starts no process; only this loop starts the render
// child, one block at a time.

import { fromMarkdown } from 'mdast-util-from-markdown';

import { sha256Hex } from '../../core/evidence/sha256';
import { diagramTooDeep, OPERATOR_DOCS_DIAGRAM_KIND, type DocsDiagramState, type DocsDiagramV1 } from '../../core/operator/docs';
import { readRepoHarnessRegistryStrictSnapshot } from '../repo-registry';
import { keepObservation, startObservationLoop } from '../observation-loop';
import type { DocsRepositoryCache } from './docs-collector';
import { probeRenderCapability, renderDiagramPass, readStoredDiagram, storeDiagram, type RenderCapability, type RenderPassOptions, type RenderPassResult } from './diagram-render';

export const DIAGRAM_LANGUAGE = 'eraser-diagram';
export const DIAGRAM_RENDER_INTERVAL_MS = 60_000;
const MARKDOWN = /\.(?:md|markdown)$/iu;

/** The parsed JSON documents of a markdown text's diagram blocks. A block that is not JSON has none: the page reports its syntax error. */
export function diagramDocuments(markdown: string): unknown[] {
  const documents: unknown[] = [];
  const visit = (node: { type: string; lang?: string | null; value?: string; children?: unknown[] }): void => {
    if (node.type === 'code' && node.lang === DIAGRAM_LANGUAGE) {
      // A syntax error or a nesting over the bound has no artifact: the page shows that block's own error.
      try { const document: unknown = JSON.parse(node.value ?? ''); if (!diagramTooDeep(document)) documents.push(document); } catch { /* the page shows the syntax error */ }
    }
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(fromMarkdown(markdown));
  return documents;
}

/** The content hash of one block; the page computes the same value from its parsed block. */
export const diagramHash = (document: unknown): string => sha256Hex(JSON.stringify(document));

export interface DiagramRendererOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly read_docs: (repositoryId: string) => DocsRepositoryCache;
  readonly interval_ms?: number;
  /** Replaces the render child (tests). */
  readonly render?: (options: RenderPassOptions) => Promise<RenderPassResult>;
}

export interface DiagramRendererHandle {
  /** The capability the last cycle found; `pending` before the first cycle. Never starts work. */
  readonly capability: () => RenderCapability | { readonly state: 'pending' };
  readonly settled: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function startDiagramRenderer(options: DiagramRendererOptions): DiagramRendererHandle {
  const render = options.render ?? renderDiagramPass;
  // `<fingerprint> <repository> <path>` -> the blob hash already scanned, so an unchanged file is not read again.
  const scanned = new Map<string, string>();

  const loop = startObservationLoop<RenderCapability, 'render_failed'>({
    cycle: async ({ signal }) => {
      const capability = probeRenderCapability(options.env);
      if (capability.state !== 'ready') return { state: 'observed', value: capability };
      let ids: readonly string[];
      try { ids = readRepoHarnessRegistryStrictSnapshot({ env: options.env }).repos.map(repo => repo.id); }
      catch { return { state: 'observed', value: capability }; }
      for (const id of ids) {
        const cache = options.read_docs(id);
        if (cache.state !== 'ready') continue;
        for (const file of cache.tree.files) {
          if (signal.aborted) return { state: 'observed', value: capability };
          if (!MARKDOWN.test(file.path)) continue;
          const key = `${capability.fingerprint} ${id} ${file.path}`;
          if (scanned.get(key) === file.sha256) continue;
          let text: string;
          try { text = (await cache.reader.file(file.path)).text; } catch { continue; }
          // One block that fails to hash, draw or store never stops the others; the file is scanned again next cycle.
          let complete = true;
          for (const document of diagramDocuments(text)) {
            try {
              const hash = diagramHash(document);
              if (readStoredDiagram(options.env, hash)?.fingerprint === capability.fingerprint) continue;
              const result = await render({ capability, document, outputs: { svg: true, png: false }, env: options.env, signal });
              if (signal.aborted) return { state: 'observed', value: capability };
              const fingerprint = capability.fingerprint;
              if (result.ok) storeDiagram(options.env, hash, { status: 'ok', fingerprint }, result.svg);
              else if (result.kind === 'invalid') storeDiagram(options.env, hash, { status: 'invalid', fingerprint, issues: result.issues }, null);
              else storeDiagram(options.env, hash, { status: 'failed', fingerprint, reason: result.reason }, null);
            } catch { complete = false; }
          }
          if (!complete) continue;
          scanned.set(key, file.sha256);
        }
      }
      return { state: 'observed', value: capability };
    },
    keep: keepObservation,
    failure: 'render_failed',
    interval_ms: options.interval_ms ?? DIAGRAM_RENDER_INTERVAL_MS,
  });
  return Object.freeze({
    capability: () => (loop.read().state === 'observed' ? (loop.read() as { value: RenderCapability }).value : { state: 'pending' } as const),
    settled: loop.settled,
    close: loop.close,
  });
}

/** The state of one block hash from the store and the capability the last cycle found. */
export function docsDiagramState(env: NodeJS.ProcessEnv, hash: string, capability: ReturnType<DiagramRendererHandle['capability']>): DocsDiagramV1 {
  const answer = (state: DocsDiagramState, extra: Partial<Pick<DocsDiagramV1, 'issues' | 'reason'>> = {}): DocsDiagramV1 =>
    ({ protocol: 1, kind: OPERATOR_DOCS_DIAGRAM_KIND, hash, state, issues: [], reason: null, ...extra });
  const stored = readStoredDiagram(env, hash);
  if (stored === null || (capability.state === 'ready' && stored.fingerprint !== capability.fingerprint && stored.status !== 'ok')) {
    return capability.state === 'unavailable' ? answer(capability.reason) : answer('pending');
  }
  if (stored.status === 'invalid') return answer('invalid', { issues: stored.issues });
  if (stored.status === 'failed') return answer('failed', { reason: stored.reason });
  // An image drawn with another library, font or icon set than the installed one is stale until the next cycle replaces it.
  return answer(capability.state === 'ready' && stored.fingerprint === capability.fingerprint ? 'rendered' : 'stale');
}
