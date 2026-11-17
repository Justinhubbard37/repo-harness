/**
 * LedgerEnforcement: checks tasks/lessons.md of the candidate tree, and its change since the
 * merge-base with a base ref, against the Lessons Retro contract
 * (docs/reference-configs/agentic-development-flow.md). It reads the entries through the one ledger
 * parser, `scripts/maintenance-triage.sh --entries`, and fails each lesson line that the parser
 * does not put into an entry. It does not read the ledger history: the merge-base is the only
 * earlier state.
 *
 * Usage: bun scripts/check-ledger-enforcement.ts --base <git-ref>
 * Exit 0: pass, human review or skipped. Exit 1: violation. Exit 2: error. An error is never a pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES } from '../src/core/ci/rules';

const LEDGER_PATH = 'tasks/lessons.md';

const REQUIRED_FIELDS = ['Date', 'Name', 'Mistake pattern', 'Prevention rule', 'Enforced by', 'Missed by', 'Why', 'Triggered by correction', 'Seen'];
const FIELDS = [...REQUIRED_FIELDS, 'Promoted'];
const MISSED_BY = ['self-verify', 'ci', 'independent-review', 'human', 'none', 'unknown'];
const SEEN = /^([1-9][0-9]*)×$/;
const PROMOTED = /^(#[1-9][0-9]*|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9][0-9]*)$/;
const RULE_ID = /^[A-Z][A-Za-z0-9]*$/;
// One spelling per theme key, so no two spellings can claim one theme.
const THEME_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One parser entry: `line` is the Date line, `owned` every line that the entry holds. */
export type LedgerEntry = { readonly line: number; readonly fields: Readonly<Record<string, string>>; readonly owned: readonly number[] };
export type Finding = { readonly entry: string; readonly field: string; readonly problem: string; readonly fix: string };
export type LedgerReport = { readonly findings: Finding[]; readonly review: string[]; readonly carried: string[] };

type Theme = { readonly entries: LedgerEntry[]; readonly latest: LedgerEntry; readonly max: number; readonly promoted: boolean };

const field = (entry: LedgerEntry, name: string): string => entry.fields[name]?.trim() ?? '';
const seen = (entry: LedgerEntry): number | null => {
  const match = SEEN.exec(field(entry, 'Seen'));
  return match ? Number(match[1]) : null;
};
const key = (entry: LedgerEntry): string => `${field(entry, 'Mistake pattern')}\n${field(entry, 'Date')}`;
const label = (entry: LedgerEntry, base = false): string =>
  `${base ? 'base ' : ''}${LEDGER_PATH}:${entry.line} ${field(entry, 'Mistake pattern') || '<no Mistake pattern>'} (${field(entry, 'Date') || 'no Date'})`;
// The same reference normalization as maintenance triage: case, a leading '#', and a short SHA.
const normalize = (ref: string): string => {
  const value = ref.toLowerCase().replace(/^[\s#]+|\s+$/g, '');
  return /^[0-9a-f]{8,40}$/.test(value) ? value.slice(0, 8) : value;
};
const list = (entry: LedgerEntry, name: string): string[] => field(entry, name).split(',').map((ref) => ref.trim()).filter(Boolean);
const references = (entry: LedgerEntry): string[] => list(entry, 'Triggered by correction');
const promotions = (entries: readonly LedgerEntry[]): string[] => entries.flatMap((entry) => list(entry, 'Promoted'));
/** A structural enforcer is a path or a rule id; `judgment` and an empty value are not. */
const structural = (entry: LedgerEntry): boolean => !['', 'judgment'].includes(field(entry, 'Enforced by'));
/** The state that row 4 fails: Seen 3× or more, no structural enforcer, no Promoted. */
const judged = (theme: Theme): boolean => theme.max >= 3 && !structural(theme.latest) && !theme.promoted;

/** Groups the entries with a theme and a valid Seen by theme, in ledger order. */
function themes(entries: readonly LedgerEntry[]): Map<string, Theme> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const theme = field(entry, 'Mistake pattern');
    if (theme && seen(entry) !== null) groups.set(theme, [...groups.get(theme) ?? [], entry]);
  }
  return new Map([...groups].map(([theme, group]) => {
    const latest = group.reduce((top, entry) => seen(entry)! >= seen(top)! ? entry : top);
    return [theme, { entries: group, latest, max: seen(latest)!, promoted: group.some((entry) => field(entry, 'Promoted') !== '') }];
  }));
}

/**
 * Applies the decision table to the head ledger and to its change against the base entries.
 * `text` is the head ledger text and `head` its parser entries. `base` is null when the merge-base
 * has no ledger. `resolves` tells whether a repository path is a file of the candidate tree.
 */
export function evaluateLedger(text: string, head: readonly LedgerEntry[], base: readonly LedgerEntry[] | null, resolves: (path: string) => boolean): LedgerReport {
  const findings: Finding[] = [];
  const review: string[] = [];
  const carried: string[] = [];
  const add = (entry: LedgerEntry, name: string, problem: string, fix: string, inBase = false) =>
    findings.push({ entry: label(entry, inBase), field: name, problem, fix });

  // Row 1, parser completeness: each non-blank line must be owned by one parsed entry. Before the
  // first entry, only headings and the `reviewed-through:` watermark may stand alone. A lesson
  // without a Date, another bullet style, a repeated field that the parser skips, or any other text
  // belongs to no entry, so no other row would see it.
  const owned = new Set(head.flatMap((entry) => entry.owned));
  const first = head[0]?.line ?? Infinity;
  for (const [index, line] of text.split('\n').entries()) {
    const number = index + 1;
    if (!line.trim() || owned.has(number) || (number < first && /^(#{1,6} |reviewed-through: )/.test(line))) continue;
    findings.push({
      entry: `${LEDGER_PATH}:${number}`, field: /^[-*+]? ?([A-Z][A-Za-z ]*):/.exec(line)?.[1] ?? 'line',
      problem: `"${line.slice(0, 80)}" belongs to no entry`,
      fix: 'start each lesson with "- Date: <YYYY-MM-DD>" and write each field once as "- <Field>: <value>"',
    });
  }

  // Row 1: required and known fields, the theme key spelling, the Missed by enum, the Seen count and
  // the Promoted format.
  // Row 3: an Enforced by path or rule id that does not exist. Row 6: one that exists needs human review.
  for (const entry of head) {
    for (const name of REQUIRED_FIELDS) {
      if (!field(entry, name)) add(entry, name, 'is missing or empty', `add "- ${name}: <value>" as the Lessons Retro template states`);
    }
    for (const name of Object.keys(entry.fields).filter((name) => !FIELDS.includes(name))) {
      add(entry, name, 'is not a Lessons Retro field', `remove it, or use one of ${FIELDS.join(', ')}`);
    }
    const theme = field(entry, 'Mistake pattern');
    if (theme && !THEME_KEY.test(theme)) add(entry, 'Mistake pattern', `"${theme}" is not a theme key`, 'write the key in lowercase words joined by "-", and copy it exactly for each entry of the theme');
    const missedBy = field(entry, 'Missed by');
    if (missedBy && !MISSED_BY.includes(missedBy)) add(entry, 'Missed by', `"${missedBy}" is not a valid value`, `write one of ${MISSED_BY.join(', ')}`);
    const count = field(entry, 'Seen');
    if (count && seen(entry) === null) add(entry, 'Seen', `"${count}" is not a positive integer count`, 'write the cumulative event count of the theme as <N>×');
    const promoted = field(entry, 'Promoted');
    if (promoted && !promoted.split(',').every((ref) => PROMOTED.test(ref.trim()))) {
      add(entry, 'Promoted', `"${promoted}" is not a PR reference or a list of them`, 'write "- Promoted: #<PR>" or the pull request URL, and separate several with ", "');
    }
    const enforcer = field(entry, 'Enforced by');
    if (!structural(entry)) continue;
    if (resolves(enforcer)) {
      review.push(`${label(entry)}: Enforced by ${enforcer} exists`);
    } else if (!RULE_ID.test(enforcer)) {
      add(entry, 'Enforced by', `${enforcer} is not a file of the candidate tree`, 'name the repository file that fails when the mistake comes back, or write judgment');
    } else if (Object.hasOwn(RULES, enforcer)) {
      review.push(`${label(entry)}: Enforced by rule ${enforcer} exists`);
    } else {
      add(entry, 'Enforced by', `${enforcer} is neither a file of the candidate tree nor a rule id in src/core/ci/rules.ts`,
        `name a registered rule id (${Object.keys(RULES).join(', ')}), a repository file, or write judgment`);
    }
  }

  // Row 2 on the candidate tree: one entry per theme and day, and a Seen that rises in ledger order.
  const headKeys = new Map<string, LedgerEntry>();
  for (const entry of head) {
    const earlier = headKeys.get(key(entry));
    if (earlier && field(entry, 'Mistake pattern') && field(entry, 'Date')) {
      add(entry, 'Date', `line ${earlier.line} has an entry of this theme on the same day`, 'merge the two entries into one entry for that day');
    } else headKeys.set(key(entry), entry);
  }
  const headThemes = themes(head);
  for (const { entries } of headThemes.values()) {
    for (const [index, entry] of entries.entries()) {
      const before = entries[index - 1];
      if (before && seen(entry)! <= seen(before)!) {
        add(entry, 'Seen', `${seen(entry)}× does not exceed ${seen(before)}× of the earlier entry at line ${before.line}`,
          'Seen is cumulative: add the new correction events to the last valid Seen value of the theme');
      }
    }
  }

  // The change: Mistake pattern is the immutable theme key, so a head theme continues only the
  // merge-base theme with the same key. A Name change is free. A key that leaves the ledger fails,
  // also when another theme absorbs its entries: the key of a consolidation survives.
  const baseThemes = base === null ? new Map<string, Theme>() : themes(base);
  for (const [theme, before] of baseThemes) {
    const after = headThemes.get(theme);
    if (!after) {
      add(before.latest, 'Mistake pattern', 'is a theme key that is no longer in the ledger',
        'keep the key: a rename changes only Name, and a consolidation keeps the key of the theme it continues', true);
      continue;
    }
    if (after.max < before.max) {
      add(after.latest, 'Seen', `the theme maximum fell from ${before.max}× to ${after.max}×`, `the maximum of a theme never falls; write ${before.max}×`);
      continue;
    }
    // Missing base Dates mark absorbed entries even when new events keep the entry count level.
    // The consolidated series keeps the base maximum; a separate new entry may raise Seen.
    const dates = new Set(after.entries.map((entry) => field(entry, 'Date')));
    const consolidation = before.entries.some((entry) => !dates.has(field(entry, 'Date')));
    const consolidated = consolidation ? after.entries.find((entry) => seen(entry) === before.max) : undefined;
    if (consolidation) {
      const merged = `a consolidation of ${before.entries.length} entries into ${after.entries.length}`;
      if (!consolidated) {
        add(after.latest, 'Seen', `${merged} gives ${after.max}×`, `a consolidation keeps the maximum ${before.max}×; record a new correction event in a separate entry`);
      } else {
        const kept = new Set(list(consolidated, 'Promoted').map(normalize));
        const replaced = before.entries.filter((entry) => !dates.has(field(entry, 'Date')) || field(entry, 'Date') === field(consolidated, 'Date'));
        const lost = promotions(replaced).filter((ref) => !kept.has(normalize(ref)));
        if (lost.length) add(consolidated, 'Promoted', `${merged} drops Promoted ${lost.join(', ')}`, 'keep every Promoted reference of the entries that the consolidation replaces');
        const enforcer = field(before.latest, 'Enforced by');
        if (field(consolidated, 'Enforced by') !== enforcer) {
          add(consolidated, 'Enforced by', `${merged} changes ${enforcer} to ${field(consolidated, 'Enforced by') || 'nothing'}`, `keep "- Enforced by: ${enforcer}"`);
        }
      }
    }
    for (const entry of before.entries) {
      const now = after.entries.find((candidate) => field(candidate, 'Date') === field(entry, 'Date'));
      const sameDayLatest = now === after.latest && field(now, 'Date') === field(before.latest, 'Date');
      if (now && seen(now) !== seen(entry) && now !== consolidated && !sameDayLatest) {
        add(now, 'Seen', `changed from ${seen(entry)}× to ${seen(now)}× on an existing entry`, `restore ${seen(entry)}×; do not edit Seen on older entries`);
      }
    }
  }
  if (base !== null) {
    // Row 5: a merge keeps every Triggered by correction reference of the entries it replaces.
    const kept = new Set(head.flatMap(references).map(normalize));
    for (const entry of base) {
      const lost = references(entry).filter((ref) => !kept.has(normalize(ref)));
      if (lost.length) {
        add(entry, 'Triggered by correction', `${lost.join(', ')} is no longer in the ledger`,
          'keep every reference of the entries that a merge replaces, and add the consolidating PR beside them', true);
      }
    }
  }

  // Row 4: Seen 3× or more with Enforced by: judgment needs Promoted. The state is carried when the
  // merge-base theme with the same key already has it at the same maximum: this change did not make
  // it, and maintenance triage lists it. A new event, a removed Promoted or a change from a path to
  // judgment makes it again, also through an absorbed entry.
  for (const [theme, state] of headThemes) {
    if (state.max < 3 || field(state.latest, 'Enforced by') !== 'judgment' || state.promoted) continue;
    const before = baseThemes.get(theme);
    if (before && judged(before) && before.max === state.max) {
      carried.push(`${label(state.latest)}: Seen ${state.max}× with Enforced by: judgment and no Promoted`);
    } else {
      add(state.latest, 'Promoted', `Seen ${state.max}× with Enforced by: judgment has no Promoted`,
        'promote the prevention rule into root AGENTS.md and root CLAUDE.md in this PR and add "- Promoted: #<PR>", or name the enforcing file in Enforced by');
    }
  }
  return { findings, review, carried };
}

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[]): string {
  const result = run('git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** Parses one ledger text with the triage parser and checks the shape of its output. */
function parseLedger(text: string): LedgerEntry[] {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-enforcement-'));
  try {
    const file = join(directory, 'lessons.md');
    writeFileSync(file, text);
    const result = run('bash', [join(import.meta.dir, 'maintenance-triage.sh'), '--entries', file]);
    if (result.status !== 0) throw new Error(`the ledger parser failed: ${result.stderr.trim()}`);
    const entries: unknown = JSON.parse(result.stdout);
    const record = (value: unknown, type: string) => value !== null && typeof value === 'object' && Object.values(value).every((item) => typeof item === type);
    if (!Array.isArray(entries) || !entries.every((entry) => Number.isInteger(entry?.line) && record(entry.fields, 'string')
      && Array.isArray(entry.owned) && entry.owned.every(Number.isInteger))) {
      throw new Error('the ledger parser output is not a list of {line, fields, owned}');
    }
    return entries as LedgerEntry[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main(args: string[]): number {
  if (args.length !== 2 || args[0] !== '--base' || !args[1] || args[1].startsWith('-')) {
    console.error('Usage: bun scripts/check-ledger-enforcement.ts --base <git-ref>');
    return 2;
  }
  const root = git(['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);
  // The change of this PR starts at the merge-base, so a base commit made after the branch cut
  // does not count as part of it.
  const ref = git(['rev-parse', '--verify', `${args[1]}^{commit}`]).trim();
  const baseSha = git(['merge-base', ref, 'HEAD']).trim();
  const inBase = git(['ls-tree', '--name-only', baseSha, '--', LEDGER_PATH]).trim() === LEDGER_PATH;
  const inHead = existsSync(LEDGER_PATH);
  const where = `merge-base ${baseSha.slice(0, 12)}`;
  if (!inHead && !inBase) {
    console.log(`[ledger] LedgerEnforcement: skipped. Neither the candidate tree nor ${where} has ${LEDGER_PATH}.`);
    return 0;
  }
  if (!inHead) {
    console.log(`[ledger] LedgerEnforcement: violation. ${LEDGER_PATH} is the one lessons ledger and this change removes it. Fix: restore ${LEDGER_PATH}.`);
    return 1;
  }
  const text = readFileSync(LEDGER_PATH, 'utf8');
  const head = parseLedger(text);
  const base = inBase ? parseLedger(git(['show', `${baseSha}:${LEDGER_PATH}`])) : null;
  const files = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  const report = evaluateLedger(text, head, base, (path) => files.has(path) && existsSync(path));
  const state = report.findings.length ? 'violation' : report.review.length ? 'human review' : 'pass';
  console.log(`[ledger] LedgerEnforcement: ${state}. ${head.length} entries, ${report.findings.length} findings, against ${where}.`);
  for (const finding of report.findings) console.log(`[ledger] ${finding.entry}: ${finding.field} ${finding.problem}. Fix: ${finding.fix}.`);
  for (const line of report.carried) console.log(`[ledger] Carried from the base, not changed here: ${line}. rh run maintenance-triage lists it.`);
  for (const line of report.review) console.log(`[ledger] Human review: ${line}. This check does not prove that it covers the whole mistake class.`);
  if (report.findings.length) console.log(`[ledger] ${RULES.LedgerEnforcement.repair}`);
  return report.findings.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`[ledger] LedgerEnforcement: error. ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
