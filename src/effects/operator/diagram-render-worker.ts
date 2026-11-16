// One-shot child of `renderDiagramPass`: argv is <capability dir> <browser path> <job dir>.
// It reads `input.json` from the job directory and writes `result.json` there. The
// library and Playwright load from the capability directory, never from the core package.
// The browser starts through `launchServer` so that its pid, written to `browser.pid`,
// lets the parent end the browser's own process group.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const [directory, browserPath, job] = process.argv.slice(2) as [string, string, string];
const ICON_NAME = /^[a-z0-9][a-z0-9-]*$/u;

interface LibraryError { readonly code: string; readonly path?: string; readonly message: string }
type Result = Record<string, unknown>;

const requireFromCapability = createRequire(join(directory, 'package.json'));
// The modules live in the capability directory, outside this package, so a literal import cannot name them.
const load = async (name: string): Promise<any> => requireFromCapability(name);

function fontsConfig(libraryDir: string) {
  const stock = join(libraryDir, 'fonts');
  const faces: Record<string, unknown>[] = [
    { kind: 'file', family: 'ShantellSans', path: join(stock, 'ShantellSans.var.woff2'), format: 'woff2', weight: '300 800', inline: true },
    { kind: 'file', family: 'Inter', path: join(stock, 'Inter.var.woff2'), format: 'woff2', weight: '100 900', inline: true },
    { kind: 'file', family: 'JetBrainsMono', path: join(stock, 'JetBrainsMono-Regular.woff2'), format: 'woff2', inline: true },
  ];
  const fallbacks = { rough: 'sans-serif', clean: 'sans-serif', mono: 'monospace' };
  // Each file in `fonts/` is an extra fallback face, so Chinese text has a glyph on a host with no CJK system font.
  const extra = (() => { try { return readdirSync(join(directory, 'fonts')).sort().filter(name => /\.(?:ttf|otf|woff2)$/iu.test(name)); } catch { return []; } })();
  extra.forEach((name, index) => {
    const format = name.endsWith('.woff2') ? 'woff2' : name.endsWith('.otf') ? 'opentype' : 'truetype';
    faces.push({ kind: 'file', family: `CapabilityFont${index}`, path: join(directory, 'fonts', name), format, weight: '100 900', inline: true });
  });
  if (extra.length > 0) {
    const list = extra.map((_, index) => `"CapabilityFont${index}"`).join(',');
    fallbacks.rough = `${list},sans-serif`; fallbacks.clean = `${list},sans-serif`; fallbacks.mono = `${list},monospace`;
  }
  return { roles: { rough: 'ShantellSans', clean: 'Inter', mono: 'JetBrainsMono' }, faces, fallbacks, throwOnFontFail: true };
}

/** The scene's HTML as a foreignObject SVG, so the docs page shows it as an image. */
async function wrapAsSvg(html: string, wsEndpoint: string): Promise<string> {
  const { chromium } = await load('playwright-core');
  const browser = await chromium.connect(wsEndpoint);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const scene = document.getElementById('eraser-scene')!;
      const { width, height } = scene.getBoundingClientRect();
      const css = [...document.querySelectorAll('head style')].map(style => style.textContent).join('\n');
      const xml = new XMLSerializer();
      const clone = scene.cloneNode(true);
      // XML forbids `--` inside a comment, and the scene's comments can hold it.
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments: Node[] = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach(comment => (comment as ChildNode).remove());
      const body = xml.serializeToString(clone);
      const style = xml.serializeToString(Object.assign(document.createElement('style'), { textContent: css }));
      const w = Math.ceil(width);
      const h = Math.ceil(height);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="margin:0">${style}${body}</div></foreignObject></svg>`;
    });
  } finally {
    await browser.close();
  }
}

async function render(): Promise<Result> {
  const input = JSON.parse(readFileSync(join(job, 'input.json'), 'utf8')) as { document: unknown; outputs: { svg: boolean; png: boolean } };
  const { chromium } = await load('playwright-core');
  const server = await chromium.launchServer({ executablePath: browserPath });
  writeFileSync(join(job, 'browser.pid'), String(server.process().pid));
  try {
    const library = await load('@eraserlabs/diagrams');
    const libraryDir = dirname(requireFromCapability.resolve('@eraserlabs/diagrams/package.json'));
    const renderer = await library.createRenderer({
      browser: () => chromium.connect(server.wsEndpoint()),
      // A name is a file in the capability's `icons/`; nothing loads from the network.
      iconLoader: async (name: string) => {
        if (!ICON_NAME.test(name)) throw new Error(`invalid icon name "${name}"`);
        return readFileSync(join(directory, 'icons', `${name}.svg`), 'utf8');
      },
      onUnknownIcon: 'error',
      fonts: fontsConfig(libraryDir),
    });
    try {
      const drawn = await renderer.render({ ...(input.document as object), outputs: { html: input.outputs.svg, png: input.outputs.png } });
      if (!drawn.ok) {
        const errors = drawn.errors as LibraryError[];
        if (errors.some(error => error.code === 'E_UNKNOWN_ICON' || /font/iu.test(error.code))) return { ok: false, kind: 'failed', reason: 'resource_missing' };
        return { ok: false, kind: 'invalid', issues: errors.map(error => ({ element: error.path ?? '/', field: error.code, fix: error.message })) };
      }
      const svg = input.outputs.svg ? await wrapAsSvg(drawn.html as string, server.wsEndpoint()) : null;
      return { ok: true, svg, png: input.outputs.png ? Buffer.from(drawn.png as Uint8Array).toString('base64') : null };
    } finally {
      await renderer.close();
    }
  } finally {
    await server.close();
  }
}

let result: Result;
try { result = await render(); }
catch (error) {
  const message = error instanceof Error ? error.message : '';
  result = { ok: false, kind: 'failed', reason: /font|icon|ENOENT/iu.test(message) ? 'resource_missing' : 'render_failed' };
}
writeFileSync(join(job, 'result.json'), JSON.stringify(result));
process.exit(0);
