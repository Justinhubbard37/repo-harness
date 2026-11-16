import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  BoardPostFieldsError, BoardPostSupersedesError, checkPlanSupersedes, checkPostBody, decodePostFields, renderPostBody, BOARD_POST_KINDS,
} from '../src/core/board/post';
import { decodePlanBlock, PLAN_COMMENT_HEADER } from '../src/core/board/plan-block';
import { MERGE_HOLD_HEADER, MERGE_HOLD_RELEASED_HEADER, readMergeHold } from '../src/core/board/merge';
import { ACCEPTANCE_DISPOSITION_HEADER, BOUNDARY_QUESTION_HEADER, openQuestions, parseAcceptanceDisposition, type BoardCommentPageV1 } from '../src/core/board/source';
import { BoardCollectError } from '../src/effects/board/collect';
import { runBoardPost, type BoardPostPorts } from '../src/effects/board/post';
import { buildBoardCommand } from '../src/cli/commands/board';
import { attentionHostPorts, boardHostPorts } from '../src/effects/terminal/herdr-core';

const SHA = 'a'.repeat(40);
const COORDINATOR = 'https://github.com/o/r/issues/100#issuecomment-1';
const PLAN_URL = 'https://github.com/o/r/issues/100#issuecomment-2';
const RECORD = 'https://github.com/o/r/pull/9#issuecomment-3';
const DECISION = 'https://github.com/o/r/issues/100#issuecomment-4';
const BLOCK = { protocol: 2, kind: 'repo-harness.plan', merge_order: [2862, 2863], holds: [{ issue: 2863, reason: 'owner first' }], seat_limits: { worker: 3 } } as const;
const PLAN_FIELDS = { coordinator: COORDINATOR, baseline: 'main@abc1234', block: BLOCK };
const HOLD_FIELDS = { issues: [2864, 2865], reason: 'owner said stop' };
const DISPOSITION_FIELDS = { record: RECORD, subject: SHA, findings: ['r1-01', 'r1-02'], decision: DECISION };
const QUESTION_FIELDS = { to: 'coordinator', claim: COORDINATOR, blocker: 'the contract file belongs to #2866', evidence: 'src/core/x.ts:12', options: 'A extend here | B wait for #2866', holding: 'no code outside the boundary' } as const;

const page = (comments: readonly { url: string; body: string; created_at?: string }[]): BoardCommentPageV1 => ({
  truncated: false,
  comments: comments.map(({ url, body, created_at }) => ({ url, created_at: created_at ?? '2026-11-16T10:00:00Z', author_association: 'OWNER', body })),
});
const planBody = () => renderPostBody(decodePostFields('plan', PLAN_FIELDS));

describe('each kind renders one comment that its own parser reads back with the same values', () => {
  test('the five kinds are the ones the board parses', () => {
    expect([...BOARD_POST_KINDS]).toEqual(['plan', 'hold', 'release', 'disposition', 'question']);
  });

  test('plan: the block decodes to the same merge order, holds and seat limit', () => {
    const body = planBody();
    expect(body.split('\n')[0]).toBe(PLAN_COMMENT_HEADER);
    expect(body).toContain(`Coordinator: ${COORDINATOR}`);
    expect(body).toContain('Baseline: main@abc1234');
    expect(body).not.toContain('Supersedes:');
    expect(decodePlanBlock(body)).toEqual(BLOCK);
  });

  test('plan: supersedes is one field line above the block', () => {
    const body = renderPostBody(decodePostFields('plan', { ...PLAN_FIELDS, supersedes: PLAN_URL }));
    expect(body.split('\n').slice(0, 4)).toEqual([PLAN_COMMENT_HEADER, `Coordinator: ${COORDINATOR}`, 'Baseline: main@abc1234', `Supersedes: ${PLAN_URL}`]);
    expect(decodePlanBlock(body)).toEqual(BLOCK);
  });

  test('hold and release: the merge hold reader sees the hold, the Issues: scope and the release', () => {
    const hold = renderPostBody(decodePostFields('hold', HOLD_FIELDS));
    expect(hold).toBe(`${MERGE_HOLD_HEADER}\nIssues: #2864 #2865\nReason: owner said stop`);
    expect(readMergeHold(page([{ url: PLAN_URL, body: hold }]), true)).toEqual({ status: 'held', holds: [{ comment_url: PLAN_URL, issues: [2864, 2865] }] });
    // Without the line the hold covers every item of the thread, which the parser reads as null.
    const all = renderPostBody(decodePostFields('hold', { reason: 'owner said stop' }));
    expect(readMergeHold(page([{ url: PLAN_URL, body: all }]), true)).toEqual({ status: 'held', holds: [{ comment_url: PLAN_URL, issues: null }] });
    const release = renderPostBody(decodePostFields('release', { reason: 'joint decision: go' }));
    expect(release).toBe(`${MERGE_HOLD_RELEASED_HEADER}\nReason: joint decision: go`);
    expect(readMergeHold(page([{ url: PLAN_URL, body: all, created_at: '2026-11-16T09:00:00Z' }, { url: DECISION, body: release }]), true)).toEqual({ status: 'none' });
  });

  test('disposition: the parser returns the record, subject and findings of the fields', () => {
    const body = renderPostBody(decodePostFields('disposition', DISPOSITION_FIELDS));
    expect(body.split('\n')[0]).toBe(ACCEPTANCE_DISPOSITION_HEADER);
    expect(parseAcceptanceDisposition({ url: DECISION, created_at: '2026-11-16T10:00:00Z', author_association: 'OWNER', body }))
      .toEqual({ record: '3', subject_sha: SHA, findings: ['r1-01', 'r1-02'] });
  });

  test('question: the open question reader finds it, so the board counts it as unanswered', () => {
    const body = renderPostBody(decodePostFields('question', QUESTION_FIELDS));
    expect(body.split('\n')[0]).toBe(BOUNDARY_QUESTION_HEADER);
    expect(openQuestions(page([{ url: PLAN_URL, body }]))).toEqual({ status: 'observed', questions: [{ url: PLAN_URL, created_at: '2026-11-16T10:00:00Z' }] });
  });

  test('every kind passes the roundtrip check of the posting path', () => {
    const cases = [['plan', PLAN_FIELDS], ['hold', HOLD_FIELDS], ['release', { reason: 'go' }], ['disposition', DISPOSITION_FIELDS], ['question', QUESTION_FIELDS]] as const;
    for (const [kind, fields] of cases) {
      const post = decodePostFields(kind, fields);
      expect(() => checkPostBody(post, renderPostBody(post))).not.toThrow();
    }
  });
});

describe('a field that the template does not name, a missing field and a wrong type are refused before anything is posted', () => {
  const refusal = (kind: string, fields: Record<string, unknown>): string => {
    try {
      decodePostFields(kind, fields);
    } catch (error) {
      expect(error).toBeInstanceOf(BoardPostFieldsError);
      return `${(error as BoardPostFieldsError).code}: ${(error as Error).message}`;
    }
    throw new Error(`${kind} accepted ${JSON.stringify(fields)}`);
  };

  test('an unknown key, a missing required field and a wrong type each name the key and the reason', () => {
    expect(refusal('hold', { reason: 'stop', priority: 'high' })).toBe('board_post_fields_invalid: priority: not a field of this kind');
    expect(refusal('release', {})).toBe('board_post_fields_invalid: reason: required');
    expect(refusal('hold', { reason: 7 })).toBe('board_post_fields_invalid: reason: not a string');
    expect(refusal('hold', { reason: 'two\nlines' })).toBe('board_post_fields_invalid: reason: holds a line break; each field is one line');
    expect(refusal('hold', { reason: 'stop', issues: [0] })).toBe('board_post_fields_invalid: issues: not a list of issue numbers');
    expect(refusal('disposition', { ...DISPOSITION_FIELDS, subject: 'abc' })).toBe('board_post_fields_invalid: subject: not a 40-hex subject sha');
    expect(refusal('disposition', { ...DISPOSITION_FIELDS, findings: [] })).toBe('board_post_fields_invalid: findings: not a non-empty list of finding ids, none with a comma');
    // The parser splits the line on commas, so a comma inside one id would become two findings.
    expect(refusal('disposition', { ...DISPOSITION_FIELDS, findings: ['r1-01,r1-02'] }))
      .toBe('board_post_fields_invalid: findings: not a non-empty list of finding ids, none with a comma');
    expect(refusal('question', { ...QUESTION_FIELDS, to: 'owner' })).toBe('board_post_fields_invalid: to: not coordinator');
    expect(refusal('plan', { ...PLAN_FIELDS, coordinator: 'not a url' })).toBe('board_post_fields_invalid: coordinator: not a comment URL');
    expect(refusal('plan', { ...PLAN_FIELDS, baseline: 'abc1234' })).toBe('board_post_fields_invalid: baseline: not <branch>@<sha>');
    expect(refusal('nope', {})).toBe('board_post_fields_invalid: kind: not one of plan, hold, release, disposition, question');
  });

  test('a plan block with an unknown key is refused with the block decoder reason', () => {
    const message = refusal('plan', { ...PLAN_FIELDS, block: { ...BLOCK, merge_order_extra: [] } });
    expect(message).toStartWith('board_post_fields_invalid: block: plan block invalid: ');
    expect(message).toContain('merge_order_extra');
  });

  test('text that its parser does not read back identically is a roundtrip failure', () => {
    const post = decodePostFields('disposition', DISPOSITION_FIELDS);
    const body = renderPostBody(post);
    expect(() => checkPostBody(post, body.replace('Findings: r1-01, r1-02', 'Findings: r1-01')))
      .toThrow(/the disposition reads back with another value/);
    expect(() => checkPostBody(post, body.replace(ACCEPTANCE_DISPOSITION_HEADER, MERGE_HOLD_HEADER)))
      .toThrow(/the first line is "repo-harness merge hold"/);
    expect(() => checkPostBody(post, body)).not.toThrow();
  });
});

describe('the supersedes rule of a plan', () => {
  const fields = (supersedes: string | null) => {
    const post = decodePostFields('plan', { ...PLAN_FIELDS, supersedes });
    if (post.kind !== 'plan') throw new Error('plan');
    return post.fields;
  };
  const thread = () => page([{ url: PLAN_URL, body: planBody() }]);

  test('the first plan of a thread needs no supersedes, and a URL there is refused', () => {
    expect(() => checkPlanSupersedes(fields(null), page([]))).not.toThrow();
    expect(() => checkPlanSupersedes(fields(PLAN_URL), page([]))).toThrow('the thread holds no plan comment to supersede');
  });

  test('a second plan needs the URL of an existing plan comment of the same thread', () => {
    expect(() => checkPlanSupersedes(fields(null), thread())).toThrow(BoardPostSupersedesError);
    expect(() => checkPlanSupersedes(fields(null), thread())).toThrow(`the plan ${PLAN_URL}`);
    expect(() => checkPlanSupersedes(fields(PLAN_URL), thread())).not.toThrow();
    expect(() => checkPlanSupersedes(fields(DECISION), thread())).toThrow(`not a plan comment URL of this thread: ${PLAN_URL}`);
  });

  test('a truncated comment read fails closed, with and without a supersedes URL', () => {
    expect(() => checkPlanSupersedes(fields(PLAN_URL), { truncated: true, comments: thread().comments }))
      .toThrow('the comment read was truncated');
    // The read can hide an older plan, so an absent plan under a truncated read needs the URL too.
    expect(() => checkPlanSupersedes(fields(null), { truncated: true, comments: [] }))
      .toThrow('the comment read was truncated');
  });
});

describe('runBoardPost posts through the port, and a dry run writes nothing', () => {
  const ports = (comments: readonly { url: string; body: string }[] = [], isPullRequest = true) => {
    const calls: string[] = [];
    const base: BoardPostPorts = {
      comments: target => { calls.push(`comments ${target}`); return page(comments); },
      is_pull_request: target => { calls.push(`is_pull_request ${target}`); return isPullRequest; },
      comment: (target, body) => { calls.push(`comment ${target}: ${body.split('\n')[0]}`); return 'https://github.com/o/r/issues/100#issuecomment-99'; },
    };
    return { calls, base };
  };

  test('a dry run returns the exact text and calls no port', () => {
    const run = ports();
    expect(runBoardPost({ target: 100, kind: 'hold', fields: HOLD_FIELDS, dry_run: true }, run.base, {}))
      .toEqual({ kind: 'hold', body: `${MERGE_HOLD_HEADER}\nIssues: #2864 #2865\nReason: owner said stop`, url: null });
    expect(run.calls).toEqual([]);
  });

  test('a post writes exactly one comment and returns its URL', () => {
    const run = ports();
    const result = runBoardPost({ target: 100, kind: 'hold', fields: HOLD_FIELDS, dry_run: false }, run.base, {});
    expect(result.url).toBe('https://github.com/o/r/issues/100#issuecomment-99');
    expect(run.calls).toEqual(['comment 100: repo-harness merge hold']);
  });

  test('a refused field and a plan without supersedes post nothing', () => {
    const run = ports([{ url: PLAN_URL, body: planBody() }]);
    expect(() => runBoardPost({ target: 100, kind: 'hold', fields: { reason: 'stop', extra: 1 }, dry_run: false }, run.base, {})).toThrow(BoardPostFieldsError);
    expect(() => runBoardPost({ target: 100, kind: 'plan', fields: PLAN_FIELDS, dry_run: false }, run.base, {})).toThrow(BoardPostSupersedesError);
    expect(run.calls).toEqual(['comments 100']);
  });

  test('an acceptance disposition is refused on an issue', () => {
    const run = ports([], false);
    expect(() => runBoardPost({ target: 100, kind: 'disposition', fields: DISPOSITION_FIELDS, dry_run: false }, run.base, {})).toThrow(BoardCollectError);
    expect(run.calls).toEqual(['is_pull_request 100']);
  });

  test('the seat trace line is added and the posted text still parses', () => {
    const bodies: string[] = [];
    const run = ports();
    runBoardPost({ target: 100, kind: 'hold', fields: HOLD_FIELDS, dry_run: false },
      { ...run.base, comment: (_target, body) => { bodies.push(body); return 'u'; } }, { REPO_HARNESS_SEAT: 'orchestrator', HC_TERMINAL_ID: 't2' });
    expect(bodies).toEqual([`${MERGE_HOLD_HEADER}\nIssues: #2864 #2865\nReason: owner said stop\nSeat: orchestrator t2`]);
  });
});

describe('rh board post', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const fieldsFile = (fields: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), 'rh-board-post-'));
    roots.push(root);
    const path = join(root, 'fields.json');
    writeFileSync(path, JSON.stringify(fields));
    return path;
  };
  const fakePorts = (comments: readonly { url: string; body: string }[] = [], isPullRequest = true) => {
    const writes: string[] = [];
    const ports: BoardPostPorts = {
      comments: () => page(comments),
      is_pull_request: () => isPullRequest,
      comment: (_target, body) => { writes.push(body); return 'https://github.com/o/r/issues/100#issuecomment-99'; },
    };
    return { writes, ports };
  };
  /** One `rh board post` run with its streams and its exit code captured. */
  const run = async (args: readonly string[], ports: BoardPostPorts) => {
    const stdout: string[] = [], stderr: string[] = [];
    const program = new Command().name('rh');
    program.addCommand(buildBoardCommand(boardHostPorts(), attentionHostPorts(), () => ports));
    const out = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
    const err = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await program.parseAsync([...args], { from: 'user' });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const exitCode = process.exitCode;
    process.exitCode = previous;
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
  };

  test('a hold dry run prints the comment and performs no GitHub write', async () => {
    const fake = fakePorts();
    const result = await run(['board', 'post', 'hold', '--target', '100', '--fields-file', fieldsFile({ reason: 'owner said stop' }), '--dry-run'], fake.ports);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${MERGE_HOLD_HEADER}\nReason: owner said stop\n`);
    expect(fake.writes).toEqual([]);
  });

  test('a post prints the comment URL, and --json prints the document', async () => {
    const fake = fakePorts();
    const file = fieldsFile({ reason: 'owner said stop' });
    expect((await run(['board', 'post', 'hold', '--target', '100', '--fields-file', file], fake.ports)).stdout)
      .toBe('https://github.com/o/r/issues/100#issuecomment-99\n');
    const json = await run(['board', 'post', 'hold', '--target', '100', '--fields-file', file, '--json'], fake.ports);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, kind: 'hold', url: 'https://github.com/o/r/issues/100#issuecomment-99' });
    expect(fake.writes).toHaveLength(2);
  });

  test('a refused field exits 2 with the code and the key, and posts nothing', async () => {
    const fake = fakePorts();
    const result = await run(['board', 'post', 'hold', '--target', '100', '--fields-file', fieldsFile({ reason: 'stop', priority: 'high' })], fake.ports);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false, error: 'board_post_fields_invalid', message: 'board_post_fields_invalid: priority: not a field of this kind',
    });
    expect(fake.writes).toEqual([]);
  });

  test('a second plan without supersedes exits 2 and posts nothing', async () => {
    const fake = fakePorts([{ url: PLAN_URL, body: planBody() }]);
    const result = await run(['board', 'post', 'plan', '--target', '100', '--fields-file', fieldsFile(PLAN_FIELDS)], fake.ports);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toBe('board_post_supersedes_required');
    expect(fake.writes).toEqual([]);
  });

  test('an unknown kind and an unreadable fields file exit 2', async () => {
    expect((await run(['board', 'post', 'nope', '--target', '100', '--fields-file', fieldsFile({})], fakePorts().ports)).exitCode).toBe(2);
    const missing = await run(['board', 'post', 'hold', '--target', '100', '--fields-file', join(tmpdir(), 'rh-board-post-absent.json')], fakePorts().ports);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stderr).message).toContain('cannot be read');
  });
});
