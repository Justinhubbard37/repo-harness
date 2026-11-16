import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageIcon } from '@phosphor-icons/react';
import { diagramSourceIssues, type DocsDiagramFailure } from '../core/operator/docs';
import type { OperatorTranslate } from './i18n';
import { fetchDocsDiagram } from './repository-reads';
import type { ThemeMode } from './theme';
import { ExternalLink, PageLink } from './ui';
import type { WorkspaceLocation } from './workspace-location';

/**
 * The docs reader's markdown renderer (1-DOCS-N1). Raw HTML stays text (no
 * rehype-raw), a link opens only for http, https or a path inside `docs/`, and
 * a Mermaid block is drawn by Mermaid at its strict security level, then shown
 * as an image: the SVG never enters the page's DOM.
 */

/** Draws one Mermaid source to SVG markup. */
export type MermaidRenderer = (id: string, source: string, mode: ThemeMode) => Promise<string>;

// An image cannot load the page's web fonts, so the diagram names system faces.
// Without suppressErrorRendering, a failed render leaves Mermaid's error SVG in document.body.
// Mermaid 12 defaults to the ELK layout and the neo look; dagre and classic keep the 11.x diagrams.
export const MERMAID_CONFIG = {
  startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
  layout: 'dagre', look: 'classic',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
} as const;

/** Mermaid loads only when a document has a diagram; the docs page is its only importer. */
export const renderMermaidSvg: MermaidRenderer = async (id, source, mode) => {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ ...MERMAID_CONFIG, theme: mode === 'dark' ? 'dark' : 'neutral' });
  return (await mermaid.render(id, source)).svg;
};

/** An `<img>` source: an SVG shown as an image runs no script and loads nothing. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Mermaid sizes its SVG as `width="100%"` with a `max-width`; as an image it keeps that natural width. */
function naturalWidth(svg: string): number | undefined {
  const match = /^<svg[^>]*?max-width:\s*([\d.]+)px/u.exec(svg);
  return match ? Math.round(Number(match[1])) : undefined;
}

/** One validation error: the element, the field and the fix. */
export interface DiagramIssue { readonly element: string; readonly field: string; readonly fix: string }
/**
 * The optional render capability owns the diagram grammar (tags, icons, schema); the
 * core package holds no copy of it. Without the capability every block reports `capability_missing`.
 */
export type DiagramCheck =
  | { readonly state: 'valid' }
  | { readonly state: 'invalid'; readonly issues: readonly DiagramIssue[] }
  | { readonly state: 'capability_missing' }
  | { readonly state: 'browser_missing' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly reason: DocsDiagramFailure }
  /** The stored artifact's bytes, drawn as an image; `stale` when it was drawn with another library, font or icon set. */
  | { readonly state: 'image'; readonly svg: string; readonly stale: boolean };
export type DiagramValidator = (document: unknown) => Promise<DiagramCheck>;

/** The page reads the artifact the server stored for the block's content hash; it never starts a render. */
export const validateDiagramWithCapability: DiagramValidator = async document => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(document)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const diagram = await fetchDocsDiagram(hash, new AbortController().signal);
  // The page holds the bytes it shows, so the export is those bytes even when the stored artifact changes later.
  const image = async (stale: boolean): Promise<DiagramCheck> => {
    const response = await fetch(`/api/v1/docs/diagrams/${hash}/image`);
    // The artifact left between the state read and the image read: the next refresh reads the new state.
    return response.ok ? { state: 'image', svg: await response.text(), stale } : { state: 'pending' };
  };
  switch (diagram.state) {
    case 'rendered': return image(false);
    case 'stale': return image(true);
    case 'invalid': return { state: 'invalid', issues: diagram.issues };
    case 'failed': return { state: 'failed', reason: diagram.reason! };
    default: return { state: diagram.state };
  }
};

const DIAGRAM_REFRESH_MS = 5_000;

export const DIAGRAM_LANGUAGE = 'eraser-diagram';

export type DocsLink =
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'doc'; readonly path: string }
  | { readonly kind: 'none' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * What a link in `from` may open: an http or https URL, or a relative path
 * that resolves inside `docs/`. Every other target (another scheme, a root or
 * protocol-relative path, a bare fragment, a path outside `docs/`) is text.
 */
export function docsLink(target: string, from: string): DocsLink {
  if (CONTROL.test(target)) return { kind: 'none' };
  if (SCHEME.test(target)) {
    let url: URL;
    try { url = new URL(target); } catch { return { kind: 'none' }; }
    return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'external', href: url.href } : { kind: 'none' };
  }
  const relative = target.replace(/[?#].*$/su, '');
  if (relative === '' || relative.startsWith('/') || relative.startsWith('\\')) return { kind: 'none' };
  let decoded: string;
  try { decoded = decodeURIComponent(relative); } catch { return { kind: 'none' }; }
  if (CONTROL.test(decoded) || decoded.includes('\\')) return { kind: 'none' };
  const parts = from.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.pop() === undefined) return { kind: 'none' }; continue; }
    parts.push(part);
  }
  return parts.length > 1 && parts[0] === 'docs' ? { kind: 'doc', path: parts.join('/') } : { kind: 'none' };
}

/** Keeps only the URLs a renderer may emit; `docsLink` decides what each one opens. */
function urlTransform(url: string): string {
  return SCHEME.test(url) && !/^https?:/iu.test(url) ? '' : url;
}

type Node = ExtraProps['node'];

/** The source line a top-level block starts on; the gutter shows it. */
function line(node: Node): { readonly 'data-line'?: number } {
  const start = node?.position?.start.line;
  return start === undefined ? {} : { 'data-line': start };
}

function codeText(node: Node): { readonly language: string | null; readonly text: string } | null {
  const code = node?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties.className;
  const language = Array.isArray(classes) ? classes.map(String).find(name => name.startsWith('language-'))?.slice('language-'.length) ?? null : null;
  const text = code.children.map(child => (child.type === 'text' ? child.value : '')).join('');
  return { language, text };
}

function DiagramBlock({ source, validate, t }: {
  readonly source: string; readonly validate: DiagramValidator; readonly t: OperatorTranslate;
}) {
  const [checked, setChecked] = useState<{ readonly source: string; readonly check: DiagramCheck } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const own = diagramSourceIssues(source);
    const done = (check: DiagramCheck) => {
      if (!live) return;
      setChecked({ source, check });
      // The renderer draws in the background: a block that waits, or whose image is stale, is read again.
      if (check.state === 'pending' || (check.state === 'image' && check.stale)) timer = setTimeout(() => setRound(value => value + 1), DIAGRAM_REFRESH_MS);
    };
    if (own.issues.length > 0) done({ state: 'invalid', issues: own.issues });
    else validate(own.document).then(done, () => done({ state: 'capability_missing' }));
    return () => { live = false; clearTimeout(timer); };
  }, [source, validate, round]);
  const check = checked?.source === source ? checked.check : null;
  if (check === null) return <p className="docs-figure__note" data-diagram="checking">{t('docs.diagram.checking')}</p>;
  if (check.state === 'valid') return <><p className="docs-figure__note" data-diagram="valid">{t('docs.diagram.valid')}</p><pre><code>{source}</code></pre></>;
  if (check.state === 'image') {
    return (
      <>
        {check.stale && <p className="docs-figure__note" data-diagram="stale">{t('docs.diagram.stale')}</p>}
        <img key={check.stale ? 'stale' : 'drawn'} src={svgDataUrl(check.svg)} alt={t('docs.diagram.alt')} className="docs-figure__image" data-diagram="image" />
        {/* The shown SVG is the export; the browser saves it only when the user follows this link. */}
        <a href={svgDataUrl(check.svg)} download="diagram.svg" className="docs-figure__note" data-diagram-export>{t('docs.diagram.export')}</a>
      </>
    );
  }
  if (check.state !== 'invalid') {
    const note = check.state === 'capability_missing' ? 'capability_missing' : check.state === 'browser_missing' ? 'browser_missing' : check.state === 'pending' ? 'pending' : `failed.${check.reason}` as const;
    return <><p className="docs-figure__note" data-diagram={check.state.replace('_', '-')}>{t(`docs.diagram.${note}`)}</p><pre><code>{source}</code></pre></>;
  }
  return (
    <>
      <p className="docs-figure__note" data-diagram="invalid">{t('docs.diagram.invalid')}</p>
      <ul data-diagram-issues>
        {check.issues.map((issue, index) => <li key={index}>{t('docs.diagram.issue', { element: issue.element, field: issue.field, fix: issue.fix })}</li>)}
      </ul>
      <pre><code>{source}</code></pre>
    </>
  );
}

function MermaidDiagram({ source, mode, render, t }: {
  readonly source: string; readonly mode: ThemeMode; readonly render: MermaidRenderer; readonly t: OperatorTranslate;
}) {
  const id = `docs-mermaid-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const [drawn, setDrawn] = useState<{ readonly key: string; readonly src: string | null; readonly width?: number } | null>(null);
  const key = `${mode}\n${source}`;
  useEffect(() => {
    let live = true;
    render(id, source, mode).then(
      svg => { if (live) setDrawn({ key, src: svgDataUrl(svg), width: naturalWidth(svg) }); },
      () => { if (live) setDrawn({ key, src: null }); },
    );
    return () => { live = false; };
  }, [id, key, mode, render, source]);
  const current = drawn?.key === key ? drawn : null;
  if (current === null) return <p className="docs-figure__note" data-mermaid="drawing">{t('docs.mermaid.drawing')}</p>;
  if (current.src === null) {
    return (
      <>
        <p className="docs-figure__note" data-mermaid="failed">{t('docs.mermaid.failed')}</p>
        <pre><code>{source}</code></pre>
      </>
    );
  }
  return <img src={current.src} width={current.width} alt={t('docs.mermaid.alt')} className="docs-figure__image" data-mermaid="drawn" />;
}

export interface DocsMarkdownProps {
  readonly text: string;
  /** The file the text came from; relative links resolve against it. */
  readonly path: string;
  readonly mode: ThemeMode;
  readonly onOpen: (next: WorkspaceLocation) => void;
  readonly renderMermaid?: MermaidRenderer;
  readonly validateDiagram?: DiagramValidator;
  readonly t: OperatorTranslate;
}

export function DocsMarkdown({ text, path, mode, onOpen, renderMermaid = renderMermaidSvg, validateDiagram = validateDiagramWithCapability, t }: DocsMarkdownProps) {
  // Stable component types keep a drawn diagram mounted across the page's periodic re-renders.
  const components = useMemo((): Components => ({
    p: ({ node, ...props }) => <p {...props} {...line(node)} />,
    h1: ({ node, ...props }) => <h1 {...props} {...line(node)} />,
    h2: ({ node, ...props }) => <h2 {...props} {...line(node)} />,
    h3: ({ node, ...props }) => <h3 {...props} {...line(node)} />,
    h4: ({ node, ...props }) => <h4 {...props} {...line(node)} />,
    h5: ({ node, ...props }) => <h5 {...props} {...line(node)} />,
    h6: ({ node, ...props }) => <h6 {...props} {...line(node)} />,
    ul: ({ node, ...props }) => <ul {...props} {...line(node)} />,
    ol: ({ node, ...props }) => <ol {...props} {...line(node)} />,
    blockquote: ({ node, ...props }) => <blockquote {...props} {...line(node)} />,
    hr: ({ node, ...props }) => <hr {...props} {...line(node)} />,
    // A wide table or code block scrolls inside its own box, never the page; the line
    // number sits on an outer box that the scroll does not clip.
    table: ({ node, ...props }) => <div {...line(node)}><div className="docs-table"><table {...props} /></div></div>,
    pre: ({ node, children, ...props }) => {
      const code = codeText(node);
      if (code?.language === 'mermaid') {
        return <figure className="docs-figure" {...line(node)}><MermaidDiagram source={code.text} mode={mode} render={renderMermaid} t={t} /></figure>;
      }
      if (code?.language === DIAGRAM_LANGUAGE) {
        return <figure className="docs-figure" {...line(node)}><DiagramBlock source={code.text} validate={validateDiagram} t={t} /></figure>;
      }
      return <div {...line(node)}><pre {...props}>{children}</pre></div>;
    },
    a: ({ href, children }) => linkTo(docsLink(href ?? '', path), children, onOpen),
    // The docs routes serve text only, and the page loads no remote image.
    img: ({ alt }) => (
      <span className="docs-image" data-docs-image>
        <ImageIcon size={14} aria-hidden="true" />{alt ? t('docs.image.alt', { alt }) : t('docs.image')}
      </span>
    ),
  }), [path, mode, onOpen, renderMermaid, validateDiagram, t]);
  return (
    <div className="docs-prose" data-docs-body>
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>{text}</Markdown>
    </div>
  );
}

function linkTo(link: DocsLink, children: ReactNode, onOpen: (next: WorkspaceLocation) => void) {
  if (link.kind === 'external') return <ExternalLink href={link.href}>{children}</ExternalLink>;
  if (link.kind === 'doc') return <PageLink to={{ workspace: 'docs', module: null, item: link.path }} onOpen={onOpen} className="text-kumo-link hover:underline" data-docs-link={link.path}>{children}</PageLink>;
  return <span className="docs-link-blocked" data-docs-link-blocked>{children}</span>;
}
