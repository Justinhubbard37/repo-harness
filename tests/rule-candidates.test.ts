import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  CANDIDATE_ID_DOMAIN,
  RULES_LEDGER_PATH,
  candidateId,
  decodeTriageReport,
  describeRuleStatus,
  ruleActions,
  ruleGovernance,
  ruleStatus,
  type TriageReportV1,
  type TriageThemeV1,
} from '../src/core/ci/rule-candidates';
import { sha256Hex } from '../src/core/evidence/sha256';
import { commitAll, initGitRepo, run, tmpWorkspace } from './helpers/repo-fixture';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'src/cli/index.ts');
/** A repository id in the document; the digest input is what the identity does not change. */
const REPOSITORY = 'github:acme/app';
const LEDGER_READ = { head: 'a'.repeat(40), blob: 'b'.repeat(40), dirty: false };

function theme(overrides: Partial<TriageThemeV1> = {}): TriageThemeV1 {
  return {
    key: 'trace-trigger-to-effect',
    theme: 'trace-trigger-to-effect',
    name: 'Trace trigger to effect',
    prevention_rule: 'Keep the failure evidence.',
    why: '',
    correction_sources: ['c27a36e8'],
    seen: 1,
    enforced_by: 'judgment',
    promoted: null,
    lines: [12],
    ...overrides,
  };
}

function report(
  themes: readonly TriageThemeV1[] | null,
  fieldErrors: TriageReportV1['field_errors'] = [],
  evidenceErrors: TriageReportV1['evidence_errors'] = [],
): TriageReportV1 {
  return { judgment: themes === null ? null : [], themes, field_errors: fieldErrors, evidence_errors: evidenceErrors };
}

describe('rule governance and actions', () => {
  test('a theme with a machine check has no action and the structural governance', () => {
    const structural = theme({ seen: 7, enforced_by: 'src/core/ci/rules.ts' });
    expect(ruleGovernance(structural)).toBe('structural');
    expect(ruleActions(structural)).toEqual([]);
  });

  test('a judgment theme opens enforce from Seen 2 and promote_root from Seen 3 without a promotion', () => {
    expect(ruleActions(theme({ seen: 1 }))).toEqual([]);
    expect(ruleActions(theme({ seen: 2 }))).toEqual(['enforce']);
    expect(ruleActions(theme({ seen: 3 }))).toEqual(['enforce', 'promote_root']);
  });

  test('a judgment theme with a Promoted value opens only enforce', () => {
    const promoted = theme({ seen: 3, promoted: '#2104' });
    expect(ruleGovernance(promoted)).toBe('judgment_promoted');
    expect(ruleActions(promoted)).toEqual(['enforce']);
  });

  test('an unpromoted judgment theme keeps the judgment_unpromoted governance', () => {
    expect(ruleGovernance(theme())).toBe('judgment_unpromoted');
  });
});

describe('candidate id', () => {
  test('the digest is the sha256 of the domain line, the repository, the theme key and the action', () => {
    expect(candidateId(REPOSITORY, 'worktree-cleanup', 'enforce'))
      .toBe(sha256Hex([CANDIDATE_ID_DOMAIN, REPOSITORY, 'worktree-cleanup', 'enforce'].join('\n')));
  });

  test('the two actions of one theme, two themes and two repositories give different ids', () => {
    const enforce = candidateId(REPOSITORY, 'worktree-cleanup', 'enforce');
    expect(candidateId(REPOSITORY, 'worktree-cleanup', 'promote_root')).not.toBe(enforce);
    expect(candidateId(REPOSITORY, 'release-tag-order', 'enforce')).not.toBe(enforce);
    expect(candidateId('github:acme/other', 'worktree-cleanup', 'enforce')).not.toBe(enforce);
  });

  test('a repository id or theme key that is empty or spans two lines is refused', () => {
    expect(() => candidateId('github:acme/app\n', 'worktree-cleanup', 'enforce')).toThrow();
    expect(() => candidateId('github:acme/app', '', 'enforce')).toThrow();
  });
});

describe('status document', () => {
  test('themes are sorted by key and entries is the number of all theme lines', () => {
    const status = ruleStatus(
      report([theme({ key: 'zulu', lines: [40, 12] }), theme({ key: 'alpha', seen: 5, lines: [7] })]),
      REPOSITORY, LEDGER_READ,
    );
    expect(status.themes.map((row) => row.key)).toEqual(['alpha', 'zulu']);
    expect(status.ledger.entries).toBe(3);
    expect(status.ledger.path).toBe(RULES_LEDGER_PATH);
    expect(status.repository_id).toBe(REPOSITORY);
    expect(status.kind).toBe('repo-harness.rules.status');
    expect(status.protocol).toBe(1);
  });

  test('a field error makes the ledger invalid, keeps no theme and no entries', () => {
    const status = ruleStatus(
      report(null, [{ line: 12, theme: 'trace-trigger-to-effect', field: 'Enforced by', value: '', fix: 'name the file' }]),
      REPOSITORY, LEDGER_READ,
    );
    expect(status.ledger.valid).toBe(false);
    expect(status.ledger.entries).toBeNull();
    expect(status.themes).toEqual([]);
    expect(status.ledger.field_errors).toHaveLength(1);
  });

  test('an evidence error alone keeps every theme and its candidates', () => {
    const status = ruleStatus(
      report([theme({ seen: 3 })], [], [{ theme: 'trace-trigger-to-effect', trigger: 'c27a36e8' }]),
      REPOSITORY, LEDGER_READ,
    );
    expect(status.ledger.valid).toBe(false);
    expect(status.themes).toHaveLength(1);
    expect(status.themes[0]!.actions.map((action) => action.kind)).toEqual(['enforce', 'promote_root']);
    expect(status.ledger.entries).toBe(1);
  });

  test('the document holds the relative ledger path and no absolute path', () => {
    const status = ruleStatus(report([theme({ seen: 3 })]), REPOSITORY, LEDGER_READ);
    expect(status.ledger.path).toBe('tasks/lessons.md');
    expect(JSON.stringify(status)).not.toContain(process.cwd());
  });

  test('the text lines give the ledger state, then one line for each theme', () => {
    const lines = describeRuleStatus(ruleStatus(
      report([theme({ key: 'alpha', seen: 3 }), theme({ key: 'zulu' })]), REPOSITORY, LEDGER_READ,
    ));
    expect(lines[0]).toContain('tasks/lessons.md');
    expect(lines[0]).toContain('2 entries');
    expect(lines[1]).toContain('alpha');
    expect(lines[1]).toContain('Seen 3×');
    expect(lines[1]).toContain('judgment_unpromoted');
    expect(lines[1]).toContain('enforce, promote_root');
    expect(lines[2]).toContain('no action');
  });
});

describe('triage decoder', () => {
  test('a theme row with an unknown field is refused', () => {
    expect(() => decodeTriageReport({ judgment: [], themes: [{ ...theme(), extra: true }], field_errors: [], evidence_errors: [] })).toThrow();
  });

  test('a repeated theme key is refused', () => {
    expect(() => decodeTriageReport({ judgment: [], themes: [theme(), theme()], field_errors: [], evidence_errors: [] })).toThrow();
  });

  test('a document with no ledger file decodes to an empty theme list', () => {
    const decoded = decodeTriageReport({ judgment: [], themes: [], field_errors: [], evidence_errors: [] });
    expect(decoded.themes).toEqual([]);
  });
});

function entry(themeKey: string, seen: string, extras: { enforcedBy?: string; promoted?: string } = {}): string {
  return [
    '- Date: 2026-10-01',
    `- Name: ${themeKey}`,
    `- Mistake pattern: ${themeKey}`,
    '- Prevention rule: Keep the failure evidence.',
    `- Enforced by: ${extras.enforcedBy ?? 'judgment'}`,
    '- Triggered by correction: c27a36e8',
    `- Seen: ${seen}`,
    ...(extras.promoted === undefined ? [] : [`- Promoted: ${extras.promoted}`]),
    '',
  ].join('\n');
}

/** A committed checkout whose ledger holds `entries` as its only lesson entries. */
function ledgerRepo(entries: string): string {
  const repo = tmpWorkspace('rule-candidates');
  initGitRepo(repo);
  mkdirSync(join(repo, 'tasks'), { recursive: true });
  writeFileSync(join(repo, RULES_LEDGER_PATH), `# Lessons\n\n${entries}`);
  commitAll(repo, 'docs(lessons): record the failure (#1)');
  return repo;
}

function status(repo: string, ...extra: string[]) {
  return run('bun', [CLI, 'rules', 'status', ...extra, '--target', repo], repo);
}

describe('rh rules status on a checkout', () => {
  test('lesson prose longer than 500 characters survives the real ledger parser', () => {
    const prevention = 'Trace each trigger to its observable effect. '.repeat(20).trim();
    const why = 'A symptom fix left the original cause in place. '.repeat(20).trim();
    const repo = ledgerRepo(entry('alpha', '3×')
      .replace('- Prevention rule: Keep the failure evidence.', `- Prevention rule: ${prevention}\n- Why: ${why}`));
    try {
      const result = status(repo, '--json');
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const document = JSON.parse(result.stdout);
      expect(document.ledger.valid).toBe(true);
      expect(document.themes[0].prevention_rule).toBe(prevention);
      expect(document.themes[0].why).toBe(why);
      expect(document.themes[0].actions).toHaveLength(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('a judgment theme at Seen 2 opens only enforce', () => {
    const repo = ledgerRepo(entry('alpha', '2×'));
    try {
      const document = JSON.parse(status(repo, '--json').stdout);
      expect(document.themes[0].governance).toBe('judgment_unpromoted');
      expect(document.themes[0].prevention_rule).toBe('Keep the failure evidence.');
      expect(document.themes[0].why).toBe('');
      expect(document.themes[0].correction_sources).toEqual(['c27a36e8']);
      expect(document.themes[0].actions.map((row: { kind: string }) => row.kind)).toEqual(['enforce']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('a promoted theme at Seen 3 keeps enforce and the judgment_promoted governance', () => {
    const repo = ledgerRepo(entry('alpha', '3×', { promoted: '#2104' }));
    try {
      const document = JSON.parse(status(repo, '--json').stdout);
      expect(document.themes[0].governance).toBe('judgment_promoted');
      expect(document.themes[0].promoted).toBe('#2104');
      expect(document.themes[0].actions.map((row: { kind: string }) => row.kind)).toEqual(['enforce']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('a theme enforced by a path has no action and the structural governance', () => {
    const repo = ledgerRepo(entry('alpha', '7×', { enforcedBy: 'src/core/ci/rules.ts' }));
    try {
      const result = status(repo, '--json');
      expect(result.status).toBe(0);
      const document = JSON.parse(result.stdout);
      expect(document.themes[0].governance).toBe('structural');
      expect(document.themes[0].actions).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('two runs print the same candidate ids, and the two actions of one theme differ', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      const first = JSON.parse(status(repo, '--json').stdout);
      const second = JSON.parse(status(repo, '--json').stdout);
      expect(first.repository_id).toBe(second.repository_id);
      expect(first.themes[0].actions).toEqual(second.themes[0].actions);
      const ids = first.themes[0].actions.map((row: { candidate_id: string }) => row.candidate_id);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('the document carries the head, the committed blob and a clean working tree', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      const document = JSON.parse(status(repo, '--json').stdout);
      expect(document.ledger.head).toBe(run('git', ['rev-parse', 'HEAD'], repo).stdout.trim());
      expect(document.ledger.blob).toBe(run('git', ['rev-parse', `HEAD:${RULES_LEDGER_PATH}`], repo).stdout.trim());
      expect(document.ledger.dirty).toBe(false);
      expect(document.ledger.valid).toBe(true);
      expect(document.ledger.path).toBe(RULES_LEDGER_PATH);
      expect(JSON.stringify(document)).not.toContain(repo);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('an uncommitted ledger change sets dirty', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      writeFileSync(join(repo, RULES_LEDGER_PATH), `# Lessons\n\n${entry('alpha', '3×')}\n- Date: 2026-10-02\n`);
      expect(JSON.parse(status(repo, '--json').stdout).ledger.dirty).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test.each(['cwd', 'target'])('a subdirectory %s reads the root ledger and its dirty state', (mode) => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      writeFileSync(join(repo, RULES_LEDGER_PATH), `# Lessons\n\n${entry('beta', '2×')}`);
      const result = run('bun', [CLI, 'rules', 'status', '--json', ...(mode === 'target' ? ['--target', nested] : [])], mode === 'cwd' ? nested : repo);
      expect(result.status).toBe(0);
      const document = JSON.parse(result.stdout);
      expect(document.ledger.dirty).toBe(true);
      expect(document.themes.map((row: { key: string }) => row.key)).toEqual(['beta']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test.each([false, true])('a deleted working-tree ledger is refused (staged: %s)', (staged) => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      rmSync(join(repo, RULES_LEDGER_PATH));
      if (staged) expect(run('git', ['add', RULES_LEDGER_PATH], repo).status).toBe(0);
      const result = status(repo, '--json');
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ kind: 'repo-harness.rules.status', protocol: 1, error: { code: 'ledger_missing' } });
      expect(result.stderr).toContain(`working-tree ${RULES_LEDGER_PATH} is missing`);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('an entry with no Enforced by makes the ledger invalid and exits 1', () => {
    const repo = ledgerRepo(entry('alpha', '3×').replace('- Enforced by: judgment\n', ''));
    try {
      const result = status(repo, '--json');
      expect(result.status).toBe(1);
      const document = JSON.parse(result.stdout);
      expect(document.ledger.valid).toBe(false);
      expect(document.ledger.entries).toBeNull();
      expect(document.themes).toEqual([]);
      expect(document.ledger.field_errors).toHaveLength(1);
      expect(document.ledger.field_errors[0].field).toBe('Enforced by');
      expect(document.ledger.path).toBe(RULES_LEDGER_PATH);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('the text output gives one line for the ledger, then one for each theme', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      const result = status(repo);
      expect(result.status).toBe(0);
      const lines = result.stdout.trimEnd().split('\n');
      expect(lines[0]).toContain(RULES_LEDGER_PATH);
      expect(lines[0]).toContain('1 entry');
      expect(lines[1]).toContain('alpha');
      expect(lines[1]).toContain('Seen 3×');
      expect(lines[1]).toContain('enforce, promote_root');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('two checkouts of one GitHub repository give the same candidate ids', () => {
    // One repository, two checkout paths: the identity must not carry the path.
    const first = ledgerRepo(entry('alpha', '3×'));
    const second = ledgerRepo(entry('alpha', '3×'));
    try {
      for (const repo of [first, second]) {
        expect(run('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], repo).status).toBe(0);
      }
      const firstDocument = JSON.parse(status(first, '--json').stdout);
      const secondDocument = JSON.parse(status(second, '--json').stdout);
      expect(firstDocument.ledger.blob).toBe(secondDocument.ledger.blob);
      expect(firstDocument.repository_id).toBe('github:acme/app');
      expect(secondDocument.repository_id).toBe('github:acme/app');
      expect(firstDocument.themes[0].actions).toEqual(secondDocument.themes[0].actions);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test('a checkout with no GitHub remote gets a local identity that is stable on this host', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      const first = JSON.parse(status(repo, '--json').stdout);
      const second = JSON.parse(status(repo, '--json').stdout);
      expect(first.repository_id).toMatch(/^local:[0-9a-f]{16}$/u);
      expect(first.repository_id).toBe(second.repository_id);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('the command writes no file of the checkout', () => {
    const repo = ledgerRepo(entry('alpha', '3×'));
    try {
      // Nothing of the repository changes: the command reads git and the helper, and writes no file.
      const before = run('git', ['status', '--porcelain', '--untracked-files=all'], repo).stdout;
      expect(status(repo, '--json').status).toBe(0);
      expect(run('git', ['status', '--porcelain', '--untracked-files=all'], repo).stdout).toBe(before);
      expect(before).toBe('');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
