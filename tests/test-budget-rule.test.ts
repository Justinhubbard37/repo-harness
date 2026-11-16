import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runTestBudgetCheck } from '../src/cli/commands/rules';
import { parseTestBudgetException, testBudgetExceptionDigest } from '../src/core/ci/test-budget';
import { tmpWorkspace } from './helpers/repo-fixture';

const ROOT = join(import.meta.dir, '..');
const workspaces: string[] = [];
afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo: string, files: Record<string, string | Buffer | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(repo, path));
      continue;
    }
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(repo: string, files: Record<string, string | Buffer | null>): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'change');
  return git(repo, 'rev-parse', 'HEAD');
}

function lines(count: number, word = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${word} ${index}\n`).join('');
}

const PARAMETERS = { ratio_cap: 2, file_cap: 1, test_paths: ['tests'], product_paths: ['src'] };
const ENABLED = JSON.stringify({ rules: { TestBudget: { enabled: true, ...PARAMETERS } } });

/** A repository whose base commit holds `policy` (null: no policy file). */
function repository(policy: string | null): { repo: string; base: string } {
  const repo = tmpWorkspace('test-budget');
  workspaces.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  const base = commit(repo, {
    'src/app.ts': lines(10),
    'tests/old.test.ts': lines(5),
    'tests/moved.test.ts': lines(5),
    'src/helper.ts': lines(20, 'helper'),
    'src/tab\tapp.ts': lines(10, 'tabapp'),
    'docs/tab\tdoc.md': lines(3, 'doc'),
    ...(policy === null ? {} : { '.ai/harness/policy.json': policy }),
  });
  git(repo, 'checkout', '-q', '-b', 'pr');
  return { repo, base };
}

function check(cwd: string, base: string, head: string, body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'test-budget-body-'));
  workspaces.push(directory);
  const bodyFile = join(directory, 'body.md');
  writeFileSync(bodyFile, body);
  return runTestBudgetCheck({ cwd, base, head, bodyFile }).result;
}

function exceptionBody(testLines: number, productLines: number, testFiles: number, reason = 'The parser has no test that reaches the CRLF branch.'): string {
  return `## Goal\n\nText.\n\n## Test budget exception\r\n\r\n- Added test lines: ${testLines}\r\n- Added product lines: ${productLines}\r\n`
    + `- Added test files: ${testFiles}\r\n\r\n${reason}\r\n\r\n## Rollback\n\ngit revert.\n`;
}

describe('TestBudget evaluation', () => {
  test('a PR over the budget is a violation; the measure starts at the merge-base', () => {
    const { repo, base } = repository(ENABLED);
    const head = commit(repo, { 'src/app.ts': lines(13), 'tests/new.test.ts': lines(30) });
    // A base commit after the fork point does not enter the diff.
    git(repo, 'checkout', '-q', 'main');
    const movedBase = commit(repo, { 'src/other.ts': lines(100) });
    const result = check(repo, movedBase, head, '## Goal\n\nNo exception.\n');
    expect(result.state).toBe('violation');
    expect(result.bound.diff_start).toBe(base);
    expect(result.bound.head_sha).toBe(head);
    expect(result.measured).toEqual({ added_test_lines: 30, added_product_lines: 3, added_test_files: 1, ratio: 10, ratio_cap: 2, file_cap: 1 });
    expect(result.over_budget).toBe(true);
    expect(result.exception).toEqual({ present: false, valid: false, counts: null, reason: null });
    // From a subdirectory the check still reads the policy at the repository root.
    expect(check(join(repo, 'src'), movedBase, head, '').state).toBe('violation');
  });

  test('a PR within the budget passes', () => {
    const { repo, base } = repository(ENABLED);
    const head = commit(repo, { 'src/app.ts': lines(20), 'tests/old.test.ts': lines(15) });
    const result = check(repo, base, head, '');
    expect(result.state).toBe('pass');
    expect(result.over_budget).toBe(false);
    expect(result.measured?.ratio).toBe(1);
  });

  test('file states: binary, renames, delete-then-recreate, deletes and paths with tabs', () => {
    const { repo, base } = repository(ENABLED);
    commit(repo, { 'tests/old.test.ts': null });
    const head = commit(repo, {
      // Deleted and created again between the endpoints: a modified file, not a new one.
      'tests/old.test.ts': lines(6),
      // A binary test fixture counts as a file and adds no line.
      'tests/fixtures/image.bin': Buffer.from([0, 1, 2, 0, 255, 0]),
      // A rename inside the test paths adds no test file.
      'tests/moved.test.ts': null,
      'tests/renamed.test.ts': lines(5),
      // A rename from a product path into the test paths adds a test file.
      'src/helper.ts': null,
      'tests/helper.test.ts': lines(20, 'helper'),
      'src/app.ts': null,
      'src/main.ts': lines(10),
      // A tab inside a path name stays part of the path.
      'tests/tab\tname.test.ts': lines(2, 'tabtest'),
      'src/tab\tapp.ts': lines(12, 'tabapp'),
      'docs/tab\tdoc.md': null,
    });
    const result = check(repo, base, head, '');
    expect(result.measured).toEqual({ added_test_lines: 3, added_product_lines: 2, added_test_files: 3, ratio: 1.5, ratio_cap: 2, file_cap: 1 });
    expect(result.state).toBe('violation');
  });

  test('test lines without a product line are over the budget', () => {
    const { repo, base } = repository(ENABLED);
    const head = commit(repo, { 'tests/old.test.ts': lines(6), 'docs/guide.md': lines(50) });
    const result = check(repo, base, head, '');
    expect(result.measured?.added_product_lines).toBe(0);
    expect(result.measured?.ratio).toBeNull();
    expect(result.state).toBe('violation');
  });

  test('the parameters come from the base commit, not from the PR', () => {
    const { repo, base } = repository(JSON.stringify({ rules: { TestBudget: { ...PARAMETERS, enabled: true, ratio_cap: 20, file_cap: 0 } } }));
    const head = commit(repo, {
      '.ai/harness/policy.json': JSON.stringify({ rules: { TestBudget: { enabled: false } } }),
      'src/app.ts': lines(11),
      'tests/new.test.ts': lines(5),
    });
    const result = check(repo, base, head, '');
    expect(result.state).toBe('violation');
    expect(result.measured).toMatchObject({ ratio_cap: 20, file_cap: 0, added_test_files: 1 });
  });

  test('no configuration and an explicit off are skipped with different policy digests', () => {
    const absent = repository(null);
    const off = repository(JSON.stringify({ rules: { TestBudget: { enabled: false } } }));
    const absentResult = check(absent.repo, absent.base, commit(absent.repo, { 'tests/new.test.ts': lines(50) }), '');
    const offResult = check(off.repo, off.base, commit(off.repo, { 'tests/new.test.ts': lines(50) }), '');
    expect(absentResult.state).toBe('skipped');
    expect(offResult.state).toBe('skipped');
    expect(absentResult.measured).toBeNull();
    expect(absentResult.bound.policy_digest).not.toBe(offResult.bound.policy_digest);
  });

  test('an invalid configuration is an error, not skipped', () => {
    const { ratio_cap: _omitted, ...withoutRatioCap } = PARAMETERS;
    for (const config of [{ ...PARAMETERS, enabled: true, test_paths: ['tests/**'] }, { ...withoutRatioCap, enabled: true }]) {
      const { repo, base } = repository(JSON.stringify({ rules: { TestBudget: config } }));
      const result = check(repo, base, commit(repo, { 'src/app.ts': lines(11) }), '');
      expect(result.state).toBe('error');
      expect(result.error?.code).toBe('policy_invalid');
      expect(result.measured).toBeNull();
      expect(result.bound.policy_digest).toBeNull();
    }
  });

  test('a head without a merge-base with the base is an error', () => {
    const { repo, base } = repository(ENABLED);
    git(repo, 'checkout', '-q', '--orphan', 'unrelated');
    const head = commit(repo, { 'src/app.ts': lines(3) });
    const result = check(repo, base, head, '');
    expect(result.state).toBe('error');
    expect(result.error?.code).toBe('merge_base_unavailable');
    expect(result.bound.diff_start).toBeNull();
  });
});

describe('TestBudget exception', () => {
  test('a valid exception passes and keeps the measured numbers', () => {
    const { repo, base } = repository(ENABLED);
    const head = commit(repo, { 'src/app.ts': lines(13), 'tests/new.test.ts': lines(30) });
    const result = check(repo, base, head, exceptionBody(30, 3, 1));
    expect(result.state).toBe('pass');
    expect(result.over_budget).toBe(true);
    expect(result.measured).toMatchObject({ added_test_lines: 30, added_product_lines: 3, added_test_files: 1 });
    expect(result.exception).toEqual({
      present: true,
      valid: true,
      counts: { added_test_lines: 30, added_product_lines: 3, added_test_files: 1 },
      reason: 'The parser has no test that reaches the CRLF branch.',
    });
    const indented = exceptionBody(30, 3, 1).replace('## Test budget exception', '   ##\tTest budget exception');
    expect(check(repo, base, head, indented).state).toBe('pass');
    const afterBreaks = '## Test budget exception\n\n- Added test lines: 30\n- Added product lines: 3\n- Added test files: 1\n\n'
      + '***\n---\n\nAn existing test cannot reach this branch.\n';
    expect(check(repo, base, head, afterBreaks).exception).toMatchObject({ valid: true, reason: 'An existing test cannot reach this branch.' });
  });

  test('an empty heading, wrong numbers or an empty reason do not pass', () => {
    const { repo, base } = repository(ENABLED);
    const head = commit(repo, { 'src/app.ts': lines(13), 'tests/new.test.ts': lines(30) });
    const bulletCounts = '## Test budget exception\n\n- Added test lines: 30\n- Added product lines: 3\n- Added test files: 1\n\n';
    const plainCounts = '## Test budget exception\n\nAdded test lines: 30\nAdded product lines: 3\nAdded test files: 1\n\n';
    const headings = ['  ## Rollback', '##\tRollback', '   # Rollback', '> ## Rollback', 'Rollback\n---', 'Rollback instructions\nfor this change\n---',
      'Rollback instructions\nfor this change\n==='];
    const bodies = [
      '## Test budget exception\n\n## Rollback\n',
      exceptionBody(30, 4, 1),
      exceptionBody(30, 3, 1, ''),
      // Each next heading ends the section, so its text is not the reason.
      ...[bulletCounts, plainCounts].flatMap((counts) => headings.map((heading) => `${counts}${heading}\n\ngit revert.\n`)),
      // A heading that continues the last list item also ends the section.
      ...['  ## Rollback', '  # Rollback'].map((heading) => `${bulletCounts}${heading}\n`),
    ];
    for (const body of bodies) {
      const result = check(repo, base, head, body);
      expect(result.state).toBe('violation');
      expect(result.exception).toMatchObject({ present: true, valid: false });
    }
  });

  test('a heading in fenced code, an HTML comment or a block quote is not the section', () => {
    const section = '## Test budget exception\n\n- Added test lines: 30\n- Added product lines: 3\n- Added test files: 1\n\nReason.\n';
    for (const body of [`\`\`\`markdown\n${section}\`\`\`\n`, `<!--\n${section}-->\n`, section.replace(/^/gm, '> ')]) {
      expect(parseTestBudgetException(body)).toEqual({ status: 'absent' });
    }
    for (const body of [`${section}\n${section}`, section.replace('Reason.', '  ## Test budget exception')]) {
      expect(parseTestBudgetException(body).status).toBe('malformed');
    }
  });

  test('the exception digest changes with the section only', () => {
    const digest = (body: string) => testBudgetExceptionDigest(parseTestBudgetException(body));
    expect(digest(exceptionBody(30, 3, 1))).toBe(digest(exceptionBody(30, 3, 1).replace('Text.', 'Other text.')));
    expect(digest(exceptionBody(30, 3, 1))).not.toBe(digest(exceptionBody(30, 3, 1, 'Another reason.')));
    expect(digest('## Goal\n')).toBeNull();
  });
});

test('the CLI prints the document as a one-line notice and exits 1 on a violation', () => {
  const { repo, base } = repository(ENABLED);
  const head = commit(repo, { 'src/app.ts': lines(13), 'tests/new.test.ts': lines(30) });
  const bodyFile = join(repo, '..', `${repo.split('/').pop()}-cli-body.md`);
  workspaces.push(bodyFile);
  writeFileSync(bodyFile, exceptionBody(30, 3, 2, '100% of the cases\nneed a fixture.'));
  const run = spawnSync('bun', [join(ROOT, 'src/cli/index.ts'), 'rules', 'check', 'TestBudget', '--base', base, '--head', head,
    '--body-file', bodyFile, '--github-annotation'], { cwd: repo, encoding: 'utf8' });
  expect(run.status).toBe(1);
  const [document, notice] = run.stdout.trimEnd().split('\n');
  expect(JSON.parse(document!).state).toBe('violation');
  expect(notice!.startsWith('::notice title=repo-harness/test-budget-result/v1::')).toBe(true);
  const message = notice!.slice(notice!.indexOf('::', 2) + 2);
  expect(message.replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%')).toBe(document!);
  expect(run.stderr).not.toContain('need a fixture');
});
