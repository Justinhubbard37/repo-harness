import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { ruleStatus, type TriageReportV1, type TriageThemeV1 } from '../../src/core/ci/rule-candidates';
import { decodeDevActivitySnapshot } from '../../src/core/dev-activity/decode';
import { decodeRulesSnapshot, RULES_UNAVAILABLE_REASONS } from '../../src/core/operator/rules';
import { unavailableRuntimeOverlay } from '../../src/core/operator/runtime-status';
import { OperatorApp, type OperatorAppProps } from '../../src/operator-web/App';
import { registryOf } from '../../src/operator-web/fixtures';
import { busyDevActivity } from '../../src/operator-web/fixtures/dev-activity';
import { fetchRulesSnapshot, type RulesRead } from '../../src/operator-web/rules';
import { DEFAULT_LOCATION, parseWorkspaceLocation, workspaceHash } from '../../src/operator-web/workspace-location';

const REGISTRY = registryOf(['repo-harness']);
const NOW = Date.now();
const activity = decodeDevActivitySnapshot(busyDevActivity(NOW));
let root: Root | null = null;
let window: Window;

function installDom(): void {
  window = new Window({ url: 'http://127.0.0.1:4318/' });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }),
  });
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  });
}

beforeEach(() => installDom());
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  window.happyDOM.abort();
});

function theme(key: string, seen: number, enforced_by = 'judgment', promoted: string | null = null): TriageThemeV1 {
  return { key, theme: key, name: null, prevention_rule: 'Keep evidence.', why: 'The fix missed the cause.', correction_sources: ['#10'], seen, enforced_by, promoted, lines: [seen * 10] };
}

/**
 * 16 themes through the CLI producer: 10 judgment themes with `Seen >= 2` have
 * an action; 3 structural themes and 3 judgment themes seen once have none.
 */
const SIXTEEN: readonly TriageThemeV1[] = [
  ...Array.from({ length: 6 }, (_, index) => theme(`judgment-${index}`, 3)),
  ...Array.from({ length: 2 }, (_, index) => theme(`judgment-twice-${index}`, 2)),
  ...Array.from({ length: 2 }, (_, index) => theme(`judgment-promoted-${index}`, 4, 'judgment', '2026-11-01')),
  ...Array.from({ length: 3 }, (_, index) => theme(`structural-${index}`, 5, 'scripts/check-example.sh')),
  ...Array.from({ length: 3 }, (_, index) => theme(`judgment-once-${index}`, 1)),
];

function rulesRead(report: Partial<TriageReportV1>, dirty = false): RulesRead {
  const status = ruleStatus({ judgment: [], themes: SIXTEEN, field_errors: [], evidence_errors: [], ...report }, 'github:owner/repo',
    { head: 'abcdef0123456789abcdef0123456789abcdef01', blob: 'b'.repeat(40), dirty });
  const snapshot = decodeRulesSnapshot({ protocol: 1, kind: 'operator_rules', repository_id: REGISTRY.repositories[0]!.repository_id, collected_at: new Date(NOW - 180_000).toISOString(), status, prompts: [], routes: null, herdr: 'unavailable' });
  return { state: 'ok', snapshot };
}

function props(read: RulesRead): OperatorAppProps {
  return {
    initialLocale: 'en', initialRepositories: REGISTRY, readRepositories: async () => REGISTRY,
    initialDevActivity: activity, fetchDevActivity: async () => activity,
    initialRuntimeOverlay: unavailableRuntimeOverlay(), readRuntimeStatus: async () => unavailableRuntimeOverlay(),
    readNotifyStatus: () => new Promise(() => {}),
    readRules: async () => read,
  };
}

async function mount(hash: string, read: RulesRead): Promise<void> {
  window.location.hash = hash;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<OperatorApp {...props(read)} />));
}

const page = () => document.querySelector<HTMLElement>('[data-rules-page]')!;
const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const segmentText = (name: string) => document.querySelector(`[data-rules-segment="${name}"]`)!.textContent;

describe('rules page', () => {
  test('the page has a Candidates hash and a Ledger hash, and nothing else', () => {
    expect(parseWorkspaceLocation('#rules')).toEqual({ workspace: 'rules', module: null, item: null });
    expect(parseWorkspaceLocation('#rules/ledger')).toEqual({ workspace: 'rules', module: null, item: 'ledger' });
    expect(workspaceHash({ workspace: 'rules', module: null, item: 'ledger' })).toBe('#rules/ledger');
    expect(parseWorkspaceLocation('#rules/enabled')).toEqual(DEFAULT_LOCATION);
    expect(parseWorkspaceLocation('#rules/ledger/x')).toEqual(DEFAULT_LOCATION);
  });

  test('UX-rules-review-P1: 16 themes with 10 candidates show 10 candidate rows and 16 ledger rows from the snapshot', async () => {
    await mount('#rules', rulesRead({}));
    const rows = all('[data-rules-candidate]');
    expect(rows).toHaveLength(10);
    expect(segmentText('candidates')).toBe('Candidates10');
    expect(segmentText('ledger')).toBe('Ledger16');
    const first = document.querySelector('[data-rules-candidate="judgment-0"]')!;
    expect(first.textContent).toContain('Seen 3×');
    expect(first.querySelector('[data-rules-governance="judgment_unpromoted"]')?.textContent).toBe('Judgment · not in root rules');
    expect(Array.from(first.querySelectorAll('[data-rules-action]')).map(node => node.textContent)).toEqual(['Enforce', 'Promote to root rules']);
    expect(Array.from(document.querySelectorAll('[data-rules-candidate="judgment-twice-0"] [data-rules-action]')).map(node => node.getAttribute('data-rules-action'))).toEqual(['enforce']);
    expect(document.querySelector('[data-rules-source]')!.textContent).toBe('tasks/lessons.md · head abcdef0 · collected 3m');
    expect(document.querySelector('[data-rules-banner]')).toBeNull();

    await act(async () => (document.querySelector('[data-rules-segment="ledger"]') as HTMLElement).click());
    expect(window.location.hash).toBe('#rules/ledger');
    expect(all('[data-rules-theme]')).toHaveLength(16);
    const structural = document.querySelector('[data-rules-theme="structural-0"]')!.textContent;
    expect(structural).toContain('scripts/check-example.sh');
    expect(structural).toContain('Enforcer results: not connected');
    expect(document.querySelector('[data-rules-theme="judgment-promoted-0"]')!.textContent).toContain('2026-11-01');
    expect(document.querySelector('[data-rules-theme="judgment-promoted-0"]')!.textContent).toContain('L40');
  });

  test('UX-rules-review-N1: the page has no control that sends a write, and its read is a GET', async () => {
    await mount('#rules', rulesRead({}));
    expect(page().querySelector('button, form, input, textarea, select')).toBeNull();
    const requests: { url: string; method: string }[] = [];
    const original = globalThis.fetch;
    const answers: Response[] = [
      new Response(JSON.stringify({ error: { code: 'rules_pending', message: 'm', next_action: 'n' } }), { status: 503 }),
      new Response(JSON.stringify({ error: { code: 'new_code', message: 'A newer refusal.', next_action: 'n' } }), { status: 503 }),
      new Response('not json', { status: 502 }),
      new Response(JSON.stringify({ protocol: 1 }), { status: 200 }),
    ];
    globalThis.fetch = (async (url: string, init?: RequestInit) => { requests.push({ url, method: init?.method ?? 'GET' }); return answers.shift()!; }) as typeof fetch;
    try {
      const signal = new AbortController().signal;
      expect(await fetchRulesSnapshot('repo-a', signal)).toEqual({ state: 'unavailable', reason: 'rules_pending' });
      expect(await fetchRulesSnapshot('repo-a', signal)).toEqual({ state: 'refused', code: 'new_code', message: 'A newer refusal.' });
      expect(await fetchRulesSnapshot('repo-a', signal)).toEqual({ state: 'unavailable', reason: 'unreachable' });
      expect(await fetchRulesSnapshot('repo-a', signal)).toEqual({ state: 'unavailable', reason: 'rules_invalid' });
    } finally { globalThis.fetch = original; }
    expect(requests).toEqual(Array.from({ length: 4 }, () => ({ url: '/api/v1/repositories/repo-a/rules', method: 'GET' })));
  });

  test('UX-rules-review-F1: field errors show the error rows with line and fix, and no candidate or count', async () => {
    const read = rulesRead({ themes: null, field_errors: [{ line: 12, theme: 'alpha', field: 'Seen', value: 'three', fix: 'Write a count such as 3×.' }] });
    await mount('#rules', read);
    expect(document.querySelector('[data-rules-banner="invalid"]')!.textContent).toContain('tasks/lessons.md has 1 errors');
    expect(document.querySelector('[data-rules-candidate]')).toBeNull();
    expect(document.querySelector('[data-rules-empty]')).toBeNull();
    expect(segmentText('candidates')).toBe('Candidates');
    expect(segmentText('ledger')).toBe('Ledger');

    await act(async () => (document.querySelector('[data-rules-segment="ledger"]') as HTMLElement).click());
    const error = document.querySelector('[data-rules-field-error="12"]')!.textContent;
    for (const text of ['Line 12', 'alpha', 'Seen: three', 'Fix: Write a count such as 3×.']) expect(error).toContain(text);
    expect(document.querySelector('[data-rules-theme]')).toBeNull();
  });

  test('UX-rules-review-F2: evidence errors only keep the candidates under a warning with each theme and trigger', async () => {
    await mount('#rules', rulesRead({ evidence_errors: [{ theme: 'judgment-0', trigger: '#483' }] }, true));
    expect(all('[data-rules-candidate]')).toHaveLength(10);
    // One banner at most: evidence errors outrank the dirty ledger.
    expect(all('[data-rules-banner]').map(node => node.getAttribute('data-rules-banner'))).toEqual(['evidence']);
    const evidence = document.querySelector('[data-rules-evidence-error="judgment-0"]')!.textContent;
    expect(evidence).toContain('Triggered by correction: #483');
  });

  test('a dirty ledger warns and keeps the candidates', async () => {
    await mount('#rules', rulesRead({}, true));
    expect(document.querySelector('[data-rules-banner="dirty"]')!.textContent).toContain('The ledger has uncommitted changes');
    expect(document.querySelector('[data-rules-banner="dirty"]')!.textContent).toContain('The page shows the working-tree version of tasks/lessons.md at collection time. HEAD is shown for reference. Commit or discard the change before you file a task.');
    expect(all('[data-rules-candidate]')).toHaveLength(10);
  });

  test('a valid ledger with no candidate says so in one sentence and links to the ledger', async () => {
    await mount('#rules', rulesRead({ themes: SIXTEEN.filter(row => row.seen === 1 || row.enforced_by !== 'judgment') }));
    const empty = document.querySelector('[data-rules-empty]')!;
    expect(empty.textContent).toContain('No theme of the ledger has an open action.');
    expect(empty.querySelector('a')?.getAttribute('href')).toBe('#rules/ledger');
  });

  test('UX-rules-review-F6: each unavailable reason has its own text and no list or count; an unknown code shows the server code and message', async () => {
    const texts = new Set<string>();
    for (const reason of [...RULES_UNAVAILABLE_REASONS, 'unreachable'] as const) {
      if (root) { await act(async () => root?.unmount()); root = null; window.happyDOM.abort(); installDom(); }
      await mount('#rules', { state: 'unavailable', reason });
      const card = document.querySelector(`[data-rules-unavailable="${reason}"]`)!;
      texts.add(card.textContent ?? '');
      expect(card.querySelector('[data-dot]')?.getAttribute('data-dot')).toBe(['rules_pending', 'registry_unavailable', 'repository_not_found'].includes(reason) ? 'warn' : 'danger');
      expect(document.querySelector('[data-rules-segments], [data-rules-candidate]')).toBeNull();
    }
    expect(texts.size).toBe(RULES_UNAVAILABLE_REASONS.length + 1);
    await act(async () => root?.unmount()); root = null; window.happyDOM.abort(); installDom();
    await mount('#rules', { state: 'refused', code: 'new_code', message: 'A newer refusal.' });
    expect(document.querySelector('[data-rules-unavailable="new_code"]')!.textContent).toBe('new_code: A newer refusal.');
  });
});
