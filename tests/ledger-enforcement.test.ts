import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, initGitRepo, run, withTempRepo } from './helpers/repo-fixture';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-ledger-enforcement.ts');

const DEFAULTS: Record<string, string> = {
  Date: '2026-10-01',
  Name: 'Keep evidence',
  'Mistake pattern': 'theme-a',
  'Prevention rule': 'Keep the failure evidence.',
  'Enforced by': 'judgment',
  'Missed by': 'unknown',
  Why: 'The old entries do not name the missed layer.',
  'Triggered by correction': '#10',
  Seen: '1×',
};

/** One ledger entry in the Lessons Retro field order; null removes a field. */
function entry(fields: Record<string, string | null> = {}): string {
  const merged: Record<string, string | null> = { ...DEFAULTS, ...fields };
  return Object.entries(merged).filter(([, value]) => value !== null).map(([name, value]) => `- ${name}: ${value}`).join('\n');
}

const ledger = (...entries: string[]) => `# Lessons\n\nreviewed-through: ${'a'.repeat(40)}\n\n${entries.join('\n\n')}\n`;

type Case = { name: string; base: string | null; head: string | null; main?: string; files?: Record<string, string>; ref?: string; status: number; output: string[] };

function check({ base, head, main, files = {}, ref = 'HEAD' }: Case) {
  let result!: ReturnType<typeof run>;
  withTempRepo('ledger-enforcement-', (repo) => {
    initGitRepo(repo);
    mkdirSync(join(repo, 'tasks'));
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    if (base !== null) writeFileSync(join(repo, 'tasks', 'lessons.md'), base);
    commitAll(repo, 'base');
    // `main` is a ledger that the base branch commits after this branch was cut.
    if (main !== undefined) {
      for (const args of [['checkout', '-q', '-b', 'work'], ['checkout', '-q', 'main']]) expect(run('git', args, repo).status).toBe(0);
      writeFileSync(join(repo, 'tasks', 'lessons.md'), main);
      commitAll(repo, 'main moves');
      expect(run('git', ['checkout', '-q', 'work'], repo).status).toBe(0);
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    if (head === null) rmSync(join(repo, 'tasks', 'lessons.md'), { force: true });
    else writeFileSync(join(repo, 'tasks', 'lessons.md'), head);
    result = run('bun', [SCRIPT, '--base', ref], repo);
  });
  return result;
}

const valid = ledger(entry());
const series = ledger(entry({ 'Triggered by correction': '#10' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×' }));
const judged = ledger(entry({ 'Triggered by correction': '#10, #11, #12', Seen: '3×' }));
const three = ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×' }), entry({ Date: '2026-10-03', 'Triggered by correction': '#12', Seen: '3×', Promoted: '#30' }));

const mixedBase = ledger(entry({ Seen: '2×', 'Enforced by': 'tests/guard.test.ts', Promoted: '#30' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '3×', 'Enforced by': 'tests/guard.test.ts' }));
const mixedHead = (fields: Record<string, string | null> = {}, count = '3×', eventFields: Record<string, string | null> = {}) => ledger(entry({ Date: '2026-10-02', 'Triggered by correction': '#10, #11, #20', Seen: count, 'Enforced by': 'tests/guard.test.ts', ...fields }), entry({ Date: '2026-10-03', 'Triggered by correction': '#12', Seen: '4×', 'Enforced by': 'tests/guard.test.ts', ...eventFields }));

const cases: Case[] = [
  // Row 1: a required field, the Missed by enum and the Seen count.
  { name: 'a complete entry passes', base: null, head: valid, status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a missing required field fails', base: null, head: ledger(entry({ Name: null })), status: 1, output: ['(2026-10-01): Name is missing or empty. Fix: add "- Name: <value>"'] },
  { name: 'an invalid Missed by value fails', base: null, head: ledger(entry({ 'Missed by': 'reviewer' })), status: 1, output: ['Missed by "reviewer" is not a valid value. Fix: write one of self-verify, ci, independent-review, human, none, unknown'] },
  { name: 'a Seen that is not a positive integer fails', base: null, head: ledger(entry({ Seen: '0×' })), status: 1, output: ['Seen "0×" is not a positive integer count'] },
  // Row 1, parser completeness: every lesson line belongs to an entry.
  { name: 'a lesson before the first Date fails', base: null, head: ledger(entry({ Date: null }), entry()), status: 1, output: ['tasks/lessons.md:5: Name "- Name: Keep evidence" belongs to no entry'] },
  { name: 'a lesson without a Date after an entry fails', base: null, head: ledger(entry(), entry({ Date: null, 'Mistake pattern': 'theme-b' })), status: 1, output: ['tasks/lessons.md:15: Name "- Name: Keep evidence" belongs to no entry', 'tasks/lessons.md:16: Mistake pattern "- Mistake pattern: theme-b" belongs to no entry'] },
  { name: 'a lesson with another bullet style fails', base: null, head: `${valid}\n* Date: 2026-10-02\n* Name: Keep evidence\n`, status: 1, output: ['tasks/lessons.md:15: Date "* Date: 2026-10-02" belongs to no entry', 'tasks/lessons.md:16: Name "* Name: Keep evidence" belongs to no entry'] },
  { name: 'a theme key with another spelling fails', base: null, head: ledger(entry({ 'Mistake pattern': 'Theme A' })), status: 1, output: ['Mistake pattern "Theme A" is not a theme key'] },
  { name: 'a lesson with another bullet right after a field fails', base: null, head: `${ledger(entry({ Why: null })).trimEnd()}\n- Why: The old entries do not name the missed layer,\n  so the cause stays open.\n* Date: 2026-10-02\n+ Name: Keep evidence\n  - Mistake pattern: theme-b\n`, status: 1, output: ['LedgerEnforcement: violation. 1 entries, 3 findings', 'tasks/lessons.md:15: Date "* Date: 2026-10-02" belongs to no entry', 'tasks/lessons.md:16: Name "+ Name: Keep evidence" belongs to no entry', 'tasks/lessons.md:17: line "  - Mistake pattern: theme-b" belongs to no entry'] },
  { name: 'an unknown field fails', base: null, head: ledger(entry({ Owner: 'maintainer' })), status: 1, output: ['Owner is not a Lessons Retro field'] },
  { name: 'a Promoted that is not a PR reference fails', base: null, head: ledger(entry({ Seen: '3×', Promoted: 'yes' })), status: 1, output: ['Promoted "yes" is not a PR reference'] },
  // Row 2: the cumulative count of a theme.
  { name: 'a cumulative series passes', base: null, head: series, status: 0, output: ['LedgerEnforcement: pass. 2 entries'] },
  { name: 'a repeat that does not raise Seen fails', base: null, head: ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11' })), status: 1, output: ['(2026-10-02): Seen 1× does not exceed 1× of the earlier entry'] },
  { name: 'two entries of a theme on one day fail', base: null, head: ledger(entry(), entry({ 'Triggered by correction': '#11', Seen: '2×' })), status: 1, output: ['Date line 5 has an entry of this theme on the same day'] },
  { name: 'a new entry with one new correction passes', base: valid, head: series, status: 0, output: ['LedgerEnforcement: pass. 2 entries'] },
  { name: 'a base commit after the branch cut is not part of this change', base: valid, main: series, head: valid, ref: 'main', status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a same-day Seen raise on the single latest entry without a new reference passes', base: valid, head: ledger(entry({ Seen: '2×' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a same-day Seen raise on the latest entry passes', base: valid, head: ledger(entry({ 'Triggered by correction': '#10, #11', Seen: '2×' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a same-day Seen raise on the latest entry of a series passes', base: series, head: ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11, #12', Seen: '3×', Promoted: '#30' })), status: 0, output: ['LedgerEnforcement: pass. 2 entries, 0 findings'] },
  { name: 'an edited Seen on an older entry fails', base: ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '3×', Promoted: '#30' })), head: ledger(entry({ Seen: '2×' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '3×', Promoted: '#30' })), status: 1, output: ['Seen changed from 1× to 2× on an existing entry. Fix: restore 1×'] },
  { name: 'a Seen raise on the base latest entry with a later head entry fails', base: valid, head: ledger(entry({ Seen: '2×' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '3×', Promoted: '#30' })), status: 1, output: ['Seen changed from 1× to 2× on an existing entry. Fix: restore 1×'] },
  { name: 'a merge that keeps the maximum and the references passes', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20', Seen: '2×' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries'] },
  { name: 'a merge that adds the Seen values fails', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20', Seen: '3×' })), status: 1, output: ['Seen a consolidation of 2 entries into 1 gives 3×. Fix: a consolidation keeps the maximum 2×'] },
  { name: 'a consolidation that keeps the maximum and adds the consolidating PR passes', base: three, head: ledger(entry({ 'Triggered by correction': '#10, #11, #12, #20', Seen: '3×', Promoted: '#30' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries'] },
  { name: 'a consolidation that drops Promoted or changes Enforced by fails', base: ledger(entry({ Seen: '2×', 'Enforced by': 'tests/guard.test.ts', Promoted: '#30' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '3×', 'Enforced by': 'tests/guard.test.ts' })), head: ledger(entry({ Date: '2026-10-02', 'Triggered by correction': '#10, #11, #20', Seen: '3×' })), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 1, output: ['Promoted a consolidation of 2 entries into 1 drops Promoted #30', 'Enforced by a consolidation of 2 entries into 1 changes tests/guard.test.ts to judgment'] },
  { name: 'a consolidation that replaces a Promoted reference fails', base: ledger(entry({ Promoted: '#30' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×' })), head: ledger(entry({ Date: '2026-10-02', 'Triggered by correction': '#10, #11, #20', Seen: '2×', Promoted: '#99' })), status: 1, output: ['Promoted a consolidation of 2 entries into 1 drops Promoted #30'] },
  { name: 'a consolidation that loses one of two Promoted references fails', base: ledger(entry({ Promoted: '#30' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×', Promoted: '#31' })), head: ledger(entry({ Date: '2026-10-02', 'Triggered by correction': '#10, #11, #20', Seen: '2×', Promoted: '#30' })), status: 1, output: ['Promoted a consolidation of 2 entries into 1 drops Promoted #31'] },
  { name: 'a consolidation that keeps every Promoted reference passes', base: ledger(entry({ Promoted: '#30' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×', Promoted: '#31' })), head: ledger(entry({ Date: '2026-10-02', 'Triggered by correction': '#10, #11, #20', Seen: '2×', Promoted: '#30, #31, #99' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a field line with an ordered marker after a prose field fails', base: null, head: `${ledger(entry({ Why: null })).trimEnd()}\n- Why: The old entries do not name the missed layer,\n  so the cause stays open.\n1. Date: 2026-10-02\n   2) Name: Keep evidence\n`, status: 1, output: ['LedgerEnforcement: violation. 1 entries, 2 findings', 'tasks/lessons.md:15: line "1. Date: 2026-10-02" belongs to no entry', 'tasks/lessons.md:16: line "   2) Name: Keep evidence" belongs to no entry'] },
  { name: 'a merge that lowers the maximum fails', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20' })), status: 1, output: ['Seen the theme maximum fell from 2× to 1×'] },
  { name: 'a mixed consolidation that drops Promoted fails', base: mixedBase, head: mixedHead(), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 1, output: ['Promoted a consolidation of 2 entries into 2 drops Promoted #30'] },
  { name: 'a mixed consolidation that keeps Promoted passes', base: mixedBase, head: mixedHead({ Promoted: '#30' }), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 0, output: ['LedgerEnforcement: human review. 2 entries, 0 findings'] },
  { name: 'a mixed consolidation that loses the base maximum fails', base: mixedBase, head: mixedHead({ Promoted: '#30' }, '2×'), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 1, output: ['Fix: a consolidation keeps the maximum 3×'] },
  { name: 'a mixed consolidation that changes the current enforcer fails', base: mixedBase, head: mixedHead({ Promoted: '#30' }).replaceAll('tests/guard.test.ts', 'tests/other.test.ts'), files: { 'tests/other.test.ts': 'export {};\n' }, status: 1, output: ['Enforced by a consolidation of 2 entries into 2 changes tests/guard.test.ts to tests/other.test.ts'] },
  { name: 'a mixed consolidation that moves Promoted only to the new event fails', base: mixedBase, head: mixedHead({}, '3×', { Promoted: '#30' }), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 1, output: ['theme-a (2026-10-02): Promoted a consolidation of 2 entries into 2 drops Promoted #30'] },
  { name: 'a mixed consolidation that changes only the consolidated enforcer fails', base: mixedBase, head: mixedHead({ Promoted: '#30', 'Enforced by': 'judgment' }), files: { 'tests/guard.test.ts': 'export {};\n' }, status: 1, output: ['theme-a (2026-10-02): Enforced by a consolidation of 2 entries into 2 changes tests/guard.test.ts to judgment'] },
  { name: 'a mixed consolidation that changes only the new event enforcer passes', base: mixedBase, head: mixedHead({ Promoted: '#30' }, '3×', { 'Enforced by': 'tests/other.test.ts' }), files: { 'tests/guard.test.ts': 'export {};\n', 'tests/other.test.ts': 'export {};\n' }, status: 0, output: ['LedgerEnforcement: human review. 2 entries, 0 findings'] },
  { name: 'a mixed consolidation that raises an older entry fails', base: three, head: ledger(entry({ 'Triggered by correction': '#10, #99', Seen: '2×' }), entry({ Date: '2026-10-03', 'Triggered by correction': '#11, #12', Seen: '3×', Promoted: '#30' }), entry({ Date: '2026-10-04', 'Triggered by correction': '#13', Seen: '4×', Promoted: '#30' })), status: 1, output: ['theme-a (2026-10-01): Seen changed from 1× to 2× on an existing entry'] },
  { name: 'a consolidation that raises an older entry fails', base: three, head: ledger(entry({ 'Triggered by correction': '#10, #99', Seen: '2×' }), entry({ Date: '2026-10-03', 'Triggered by correction': '#11, #12', Seen: '3×', Promoted: '#30' })), status: 1, output: ['theme-a (2026-10-01): Seen changed from 1× to 2× on an existing entry'] },
  { name: 'a split keeps the theme key and its maximum', base: series, head: ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×' }), entry({ 'Mistake pattern': 'theme-b', Date: '2026-10-03', 'Triggered by correction': '#11' })), status: 0, output: ['LedgerEnforcement: pass. 3 entries, 0 findings'] },
  { name: 'a changed theme key fails', base: valid, head: ledger(entry({ 'Mistake pattern': 'theme-a-renamed' })), status: 1, output: ['base tasks/lessons.md:5 theme-a (2026-10-01): Mistake pattern is a theme key that is no longer in the ledger'] },
  // Row 3: the Enforced by reference exists. Row 6: an existing reference stops at human review.
  { name: 'a missing Enforced by path fails', base: null, head: ledger(entry({ 'Enforced by': 'tests/guard.test.ts' })), status: 1, output: ['Enforced by tests/guard.test.ts is not a file of the candidate tree'] },
  { name: 'an unknown Enforced by rule id fails', base: null, head: ledger(entry({ 'Enforced by': 'NoSuchRule' })), status: 1, output: ['Enforced by NoSuchRule is neither a file of the candidate tree nor a rule id in src/core/ci/rules.ts'] },
  {
    name: 'an existing path and rule id stop at human review',
    base: null,
    head: ledger(entry({ 'Enforced by': 'tests/guard.test.ts' }), entry({ 'Mistake pattern': 'theme-b', 'Enforced by': 'TestBudget' }), entry({ 'Mistake pattern': 'theme-c', 'Enforced by': 'LICENSE' })),
    files: { 'tests/guard.test.ts': 'export {};\n', LICENSE: 'MIT\n' },
    status: 0,
    output: ['LedgerEnforcement: human review. 3 entries, 0 findings', 'Human review: tasks/lessons.md:5 theme-a (2026-10-01): Enforced by tests/guard.test.ts exists. This check does not prove', 'Enforced by rule TestBudget exists', 'Enforced by LICENSE exists'],
  },
  // Row 4: Seen 3× or more with judgment needs Promoted; a state that the base already has is carried.
  { name: 'Seen 3× with judgment and no Promoted fails', base: null, head: judged, status: 1, output: ['Promoted Seen 3× with Enforced by: judgment has no Promoted. Fix: promote the prevention rule'] },
  { name: 'Seen 3× with judgment and Promoted passes', base: null, head: ledger(entry({ 'Triggered by correction': '#10, #11, #12', Seen: '3×', Promoted: '#30' })), status: 0, output: ['LedgerEnforcement: pass'] },
  { name: 'an unchanged judgment theme from the base is carried', base: judged, head: judged, status: 0, output: ['LedgerEnforcement: pass', 'Carried from the base, not changed here: tasks/lessons.md:5 theme-a (2026-10-01): Seen 3×'] },
  { name: 'a new event on a carried theme fails', base: judged, head: ledger(entry({ 'Triggered by correction': '#10, #11, #12', Seen: '3×' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#13', Seen: '4×' })), status: 1, output: ['(2026-10-02): Promoted Seen 4× with Enforced by: judgment has no Promoted'] },
  { name: 'a Name change keeps a carried theme carried', base: judged, head: ledger(entry({ Name: 'Keep failure evidence', 'Triggered by correction': '#10, #11, #12', Seen: '3×' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings', 'Carried from the base, not changed here: tasks/lessons.md:5 theme-a (2026-10-01): Seen 3×'] },
  { name: 'a removed Promoted fails', base: ledger(entry({ 'Triggered by correction': '#10, #11, #12', Seen: '3×', Promoted: '#30' })), head: judged, status: 1, output: ['Promoted Seen 3× with Enforced by: judgment has no Promoted'] },
  { name: 'a judgment theme absorbed into a kept 1× theme fails', base: ledger(entry({ 'Triggered by correction': '#10, #11, #12', Seen: '3×' }), entry({ 'Mistake pattern': 'theme-b', 'Triggered by correction': '#20' })), head: ledger(entry({ 'Mistake pattern': 'theme-b', 'Triggered by correction': '#20, #10, #11, #12' })), status: 1, output: ['base tasks/lessons.md:5 theme-a (2026-10-01): Mistake pattern is a theme key that is no longer in the ledger'] },
  // Row 5: a merge keeps every original correction reference.
  { name: 'a merge that keeps only the consolidation reference fails', base: series, head: ledger(entry({ 'Triggered by correction': '#20', Seen: '2×' })), status: 1, output: ['base tasks/lessons.md:5 theme-a (2026-10-01): Triggered by correction #10 is no longer in the ledger', 'base tasks/lessons.md:15 theme-a (2026-10-02): Triggered by correction #11 is no longer in the ledger'] },
  // The ledger file and the base commit.
  { name: 'a removed ledger fails', base: valid, head: null, status: 1, output: ['LedgerEnforcement: violation. tasks/lessons.md is the one lessons ledger and this change removes it'] },
  { name: 'no ledger on either side is skipped', base: null, head: null, status: 0, output: ['LedgerEnforcement: skipped'] },
  { name: 'an unreadable base is an error, not a pass', base: valid, head: valid, ref: 'no-such-ref', status: 2, output: ['LedgerEnforcement: error. git rev-parse --verify no-such-ref^{commit} failed'] },
];

describe('LedgerEnforcement decision table', () => {
  for (const item of cases) {
    test(item.name, () => {
      const result = check(item);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: item.status, stderr: '' });
      for (const text of item.output) expect(result.stdout).toContain(text);
    });
  }
});
