import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { BoardSeatsV1 } from '../../src/core/board/parents';
import { ROUTING_CLASSES } from '../../src/core/board/seats-settings';
import { ruleStatus, type RuleTaskV1 } from '../../src/core/ci/rule-candidates';
import { promotionCandidate, renderPromotionPrompt } from '../../src/core/ci/rule-prompt';
import { decodeDevActivitySnapshot } from '../../src/core/dev-activity/decode';
import { decodeRulesSnapshot } from '../../src/core/operator/rules';
import { unavailableRuntimeOverlay } from '../../src/core/operator/runtime-status';
import { OperatorApp, type OperatorAppProps } from '../../src/operator-web/App';
import { registryOf } from '../../src/operator-web/fixtures';
import { busyDevActivity } from '../../src/operator-web/fixtures/dev-activity';
import type { RulesPromoteBody, RulesPromotionWrite } from '../../src/operator-web/rules';

const REGISTRY = registryOf(['repo-harness']);
const REPOSITORY_ID = REGISTRY.repositories[0]!.repository_id;
const NOW = Date.now();
const activity = decodeDevActivitySnapshot(busyDevActivity(NOW));
const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
let root: Root | null = null;
let window: Window;

beforeEach(() => {
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
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  window.happyDOM.abort();
});

/** One judgment theme seen 3 times: two open actions, `enforce` first. */
const BASE = ruleStatus({
  judgment: [], field_errors: [], evidence_errors: [],
  themes: [{ key: 'worktree-cleanup', theme: 'Delete only merged worktrees', name: null, prevention_rule: 'Check the merge state first.', why: 'A dirty worktree was lost.', correction_sources: ['#2104', 'abc1234'], seen: 3, enforced_by: 'judgment', promoted: null, lines: [12, 40, 77] }],
}, 'github:owner/repo', { head: HEAD, blob: BLOB, dirty: false });
const [ENFORCE, PROMOTE] = BASE.themes[0]!.actions.map(action => action.candidate_id) as [string, string];

function snapshot({ herdr = 'ready', task = null, evidence = false }: { readonly herdr?: 'ready' | 'unavailable'; readonly task?: RuleTaskV1 | null; readonly evidence?: boolean } = {}) {
  const status = {
    ...BASE,
    // An evidence-only error keeps the themes (F9); the collector then renders no prompt.
    ...(evidence ? { ledger: { ...BASE.ledger, valid: false, evidence_errors: [{ theme: 'worktree-cleanup', trigger: 'abc1234' }] } } : {}),
    orchestration: { parent: 2879, plan_comment: true, coordinator_claim: false },
    themes: BASE.themes.map(theme => ({ ...theme, actions: theme.actions.map(action => ({ ...action, task: action.kind === 'enforce' ? task : null })) })),
  };
  const prompts = evidence ? [] : BASE.themes[0]!.actions.flatMap(action => ROUTING_CLASSES.map(route => ({ candidate_id: action.candidate_id, route, prompt: renderPromotionPrompt(promotionCandidate(BASE, action.candidate_id), route) })));
  const routes = ROUTING_CLASSES.map(name => (name === 'frontend' ? { class: name, seat: 'worker-important', runtime: 'claude', model: 'opus' } : { class: name, seat: null, runtime: null, model: null }));
  return decodeRulesSnapshot({ protocol: 1, kind: 'operator_rules', repository_id: REPOSITORY_ID, collected_at: new Date(NOW - 60_000).toISOString(), status, prompts, routes, herdr });
}

const SEATS: BoardSeatsV1 = {
  protocol: 1, kind: 'repo-harness.board-seats', observed_at: new Date(NOW).toISOString(), repository_id: '987654',
  seats: [{ address: 'w1:t1', name: 'advisor', agent: 'claude', state: 'live', status: 'idle', status_kind: null, status_msg: null, status_ms: null, turn: 0, branch: null, seat_status: 'observed', seat: 'advisor', issue: null, pr: null, parent: null }],
};

async function mount(hash: string, rules: ReturnType<typeof snapshot>, extra: Partial<OperatorAppProps> = {}): Promise<void> {
  window.location.hash = hash;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props: OperatorAppProps = {
    initialLocale: 'en', initialRepositories: REGISTRY, readRepositories: async () => REGISTRY,
    initialDevActivity: activity, fetchDevActivity: async () => activity,
    initialRuntimeOverlay: unavailableRuntimeOverlay(), readRuntimeStatus: async () => unavailableRuntimeOverlay(),
    readNotifyStatus: () => new Promise(() => {}),
    readRules: async () => ({ state: 'ok', snapshot: rules }),
    readBoardSeats: async () => ({ state: 'ok', seats: SEATS }),
    ...extra,
  };
  await act(async () => root?.render(<OperatorApp {...props} />));
}

const one = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = (selector: string) => act(async () => one(selector)!.click());
const ISSUE_URL = 'https://github.com/owner/repo/issues/2950';
type Steps = Extract<RulesPromotionWrite, { readonly state: 'ok' }>['value']['steps'];
const filed = (issue: number, steps: Steps = { issue: 'created', label: 'added', sub_issue: 'linked' }): RulesPromotionWrite =>
  ({ state: 'ok', value: { candidate_id: ENFORCE, issue, url: `https://github.com/owner/repo/issues/${issue}`, steps } });

describe('rules candidate drawer', () => {
  test('UX-rules-review-P2: a candidate row opens the drawer; Submit sends the edited prompt with the snapshot marker once', async () => {
    const bodies: RulesPromoteBody[] = [];
    let answer!: (value: RulesPromotionWrite) => void;
    await mount('#rules', snapshot(), { writeRulesPromote: async (_repository, body) => { bodies.push(body); return new Promise(resolve => { answer = resolve; }); } });
    await click('[data-rules-open="worktree-cleanup"]');
    expect(window.location.hash).toBe(`#rules/candidate/${ENFORCE}`);
    expect(one('[data-rules-corrections]')!.querySelector('a')!.getAttribute('href')).toBe('https://github.com/owner/repo/issues/2104');
    expect(one('[data-rules-route-seat="worker-important"]')!.textContent).toBe('worker-important · claude · opus');
    expect(one<HTMLButtonElement>('[data-rules-submit-button]')!.disabled).toBe(true);

    await click('[data-rules-route="frontend"]');
    const prefilled = renderPromotionPrompt(promotionCandidate(BASE, ENFORCE), 'frontend');
    const marker = `<!-- repo-harness.rules.candidate:${ENFORCE} route:frontend -->`;
    expect(one('[data-rules-marker]')!.textContent).toBe(marker);
    const field = one<HTMLTextAreaElement>('[data-rules-prompt]')!;
    expect(field.value).toBe(prefilled.slice(0, prefilled.indexOf(marker)));
    await act(async () => {
      // react-dom watches a text field through focus and keyup under happy-dom.
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '## Goal\nEdited text');
      field.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }) as unknown as Event);
    });
    await click('[data-rules-submit-button]');
    await click('[data-rules-submit-button]');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ request_id: bodies[0]!.request_id, candidate_id: ENFORCE, route: 'frontend', ledger_blob: BLOB, prompt: `## Goal\nEdited text\n${marker}\n` });
    expect(bodies[0]!.request_id).toMatch(/^[0-9a-f-]{36}$/u);
    await click('[data-rules-drawer-close]');
    expect(window.location.hash).toBe(`#rules/candidate/${ENFORCE}`);

    await act(async () => answer(filed(2950)));
    expect(one('[data-rules-filed="2950"]')!.textContent).toContain('Filed as #2950. Progress shows after the next collection.');
    expect(one('[data-rules-orchestration-missing]')!.textContent).toContain('No active coordinator claim on #2879');
    expect(one('[data-rules-submit-button]')).toBeNull();
  });

  test('UX-rules-review-N2: with Herdr unavailable the drawer has Copy prompt and no Submit', async () => {
    await mount(`#rules/candidate/${PROMOTE}`, snapshot({ herdr: 'unavailable' }));
    expect(one('[data-rules-drawer]')!.getAttribute('data-rules-drawer')).toBe(PROMOTE);
    expect(one('[data-rules-action-pick="promote_root"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(one('[data-rules-submit-button]')).toBeNull();
    expect(one('[data-rules-copy-prompt]')).not.toBeNull();
    expect(one('[data-rules-herdr-unavailable]')!.textContent).toContain('Herdr is not available on this machine');
  });

  test('UX-rules-review-F2: with evidence errors only the drawer opens with no prompt and no Submit', async () => {
    await mount(`#rules/candidate/${ENFORCE}`, snapshot({ evidence: true }));
    expect(one('[data-rules-banner="evidence"]')).not.toBeNull();
    expect(one('[data-rules-prompt-none]')).not.toBeNull();
    expect(one('[data-rules-submit-button]')).toBeNull();
  });

  test('UX-rules-review-F4: a 409 candidate_open through the write client shows the existing issue and no second Submit', async () => {
    const original = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') requests.push(url);
      return new Response(JSON.stringify({ error: { code: 'candidate_open', message: 'An open promotion task exists for this candidate.', next_action: 'Open that issue.' }, issue: 2950 }), { status: 409 });
    }) as typeof fetch;
    try {
      await mount(`#rules/candidate/${ENFORCE}`, snapshot());
      await click('[data-rules-route="important_fast"]');
      await click('[data-rules-submit-button]');
    } finally { globalThis.fetch = original; }
    expect(requests).toEqual([`/api/v1/repositories/${REPOSITORY_ID}/rules/promotions`]);
    expect(one('[data-rules-refusal="candidate_open"]')!.textContent).toContain('This candidate already has an open task.');
    expect(one('[data-rules-refusal-issue]')!.textContent).toBe('Issue #2950 exists for this candidate.');
    expect(one('[data-rules-refusal-issue] a')!.getAttribute('href')).toBe(ISSUE_URL);
    expect(one('[data-rules-submit-button]')).toBeNull();
    expect(one('[data-rules-reconcile]')).not.toBeNull();
  });

  test('UX-rules-review-F3, N1: an unconfirmed submit shows Reconcile and no Submit; Reconcile goes through the write client once', async () => {
    const posts: { readonly url: string; readonly body: unknown }[] = [];
    const original = globalThis.fetch;
    // The 200 body is the closed document of `rh rules promote --json`, as the route answers it.
    const answer = { kind: 'repo-harness.rules.promote', protocol: 1, candidate_id: ENFORCE, parent: 2879, issue: 2951, url: 'https://github.com/owner/repo/issues/2951', prompt_sha256: 'e'.repeat(64), steps: { issue: 'found', label: 'present', sub_issue: 'linked' } };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return new Promise<Response>(() => {});
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (!url.endsWith('/reconcile')) throw new TypeError('offline');
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    try {
      await mount(`#rules/candidate/${ENFORCE}`, snapshot());
      await click('[data-rules-route="simple_fast"]');
      await click('[data-rules-submit-button]');
      expect(one('[data-rules-submit="uncertain"]')).not.toBeNull();
      expect(one('[data-rules-submit-button]')).toBeNull();
      await click('[data-rules-reconcile]');
    } finally { globalThis.fetch = original; }
    const path = `/api/v1/repositories/${REPOSITORY_ID}/rules/promotions`;
    expect(posts.map(post => post.url)).toEqual([path, `${path}/reconcile`]);
    const reconcile = posts[1]!.body as { readonly request_id: string; readonly candidate_id: string };
    expect(reconcile).toEqual({ request_id: reconcile.request_id, candidate_id: ENFORCE });
    expect(reconcile.request_id).not.toBe((posts[0]!.body as { readonly request_id: string }).request_id);
    expect(one('[data-rules-reconciled]')!.textContent).toBe('Issue #2951: issue found, label present, sub-issue linked');
    const text = document.body.textContent!;
    for (const hidden of [reconcile.request_id, 'rules-prompts', answer.prompt_sha256]) expect(text).not.toContain(hidden);
  });

  test('UX-rules-review-P4: a merged task keeps the row a candidate with the link to its PR', async () => {
    const pr = { number: 2960, url: 'https://github.com/owner/repo/pull/2960', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40) };
    await mount('#rules', snapshot({ task: { issue: 2950, url: ISSUE_URL, route: 'frontend', progress: 'merged', seat: null, pull_request: pr } }));
    const row = one('[data-rules-candidate="worktree-cleanup"]')!;
    expect(row.querySelector('[data-rules-governance="judgment_unpromoted"]')).not.toBeNull();
    const merged = row.querySelector('[data-rules-progress="merged"]')!;
    expect(merged.textContent).toBe('Merged · PR #2960');
    expect(merged.querySelector('a')!.getAttribute('href')).toBe(pr.url);
    expect(row.querySelector('[data-rules-action="promote_root"] [data-rules-progress="none"]')!.textContent).toBe('Not filed');
  });

  test('UX-rules-review-P3: ready_for_go shows two labels and the GO command as copyable text; no request is sent', async () => {
    const pr = { number: 2960, url: 'https://github.com/owner/repo/pull/2960', head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40) };
    const writes: string[] = [];
    await mount(`#rules/candidate/${ENFORCE}`, snapshot({ task: { issue: 2950, url: ISSUE_URL, route: 'frontend', progress: 'ready_for_go', seat: 'worker-important', pull_request: pr } }), {
      writeRulesPromote: async () => { writes.push('promote'); return filed(1); },
      writeRulesReconcile: async () => { writes.push('reconcile'); return filed(1); },
    });
    const view = one('[data-rules-task="ready_for_go"]')!;
    expect(view.querySelector('[data-rules-progress="ready_for_go"]')!.textContent).toBe('Waiting for your GO');
    expect(view.querySelector('[data-rules-governance="judgment_unpromoted"]')).not.toBeNull();
    expect(one('[data-rules-task-seat]')!.textContent).toBe('worker-important');
    expect(one('[data-rules-go] [data-command] code')!.textContent)
      .toBe(`rh publication merge --repository owner/repo --repository-id 987654 --pr 2960 --head ${pr.head_sha} --base ${pr.base_sha} --json`);
    expect(one('[data-rules-go] button')!.getAttribute('aria-label')).toContain('Copy');
    expect(one('[data-rules-prompt]')).toBeNull();
    expect(one('[data-rules-submit-button]')).toBeNull();
    await click('[data-rules-go] button');
    expect(writes).toEqual([]);
  });
});
