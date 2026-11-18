/**
 * The repo-harness managed Global Working Rules block in the user-level host
 * instruction files (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`).
 *
 * Init writes the block, install and update refresh it, setup check compares
 * it, and uninstall removes it. All of them use the markers and the render
 * here. The block records its own reporting-language inputs, so install and
 * update can render it again without a prompt. Sync replaces a block or an
 * unmarked section only when its text equals a released one
 * (`assets/released-managed-values.v1.json`); every other text is kept.
 */

import { accessSync, constants, lstatSync, readFileSync, statSync, type Stats } from 'fs';
import { join } from 'path';
import { HostConfigError, type FragmentEdit, type HostConfigStrategy } from '../../core/host-config/types';
import { insertMarkedBlock, markedBlock, markedBlockLayout, markedBlockMarkers, removeMarkedBlock, MARKED_BLOCK_FRAGMENTS } from '../../core/host-config/marked-block';
import { openHostConfigGate, planFileRevert, type HostConfigAdoption, type HostConfigGate, type HostConfigRevertEntry } from '../../effects/host-config/gate';
import { hostConfigPaths, resolveHostPath } from '../../effects/host-config/store';
import { isReleasedGlobalRulesBlock, isReleasedGlobalRulesSection } from '../../effects/upgrade/released-values';

export const GLOBAL_RULES_SELECTOR = 'global-working-rules';
const GLOBAL_RULES_OWNER = MARKED_BLOCK_FRAGMENTS[GLOBAL_RULES_SELECTOR];
export const { begin: GLOBAL_RULES_BEGIN, end: GLOBAL_RULES_END } = markedBlockMarkers(GLOBAL_RULES_SELECTOR);
const GLOBAL_RULES_SELF_NOTE =
  '<!-- repo-harness manages this block; sync keeps an edited block unchanged. Keep personal rules outside the markers. -->';
/** The self-note of v0.8.5 to v0.32.0; a released block with it still records its reporting language. */
const RELEASED_GLOBAL_RULES_SELF_NOTE =
  '<!-- repo-harness manages this block; edits inside are overwritten on sync. Keep personal rules outside the markers. -->';
const isSelfNote = (line: string | undefined): boolean => line === GLOBAL_RULES_SELF_NOTE || line === RELEASED_GLOBAL_RULES_SELF_NOTE;
const REPORTING_LANGUAGE_PREFIX = '<!-- repo-harness reporting-language: ';
const REPORTING_LANGUAGE_SUFFIX = ' -->';
const COMPLETION_SUMMARY_LABEL_EN = 'Next cut';
const COMPLETION_SUMMARY_LABEL_ZH = '下一刀';
const DEFAULT_REPORTING_INSTRUCTION = "Use the user's language for reports; keep technical terms in English.";

export type ReportingLanguagePreset = 'follow' | 'zh-CN' | 'en' | 'custom';
const REPORTING_LANGUAGE_PRESETS: readonly ReportingLanguagePreset[] = ['follow', 'zh-CN', 'en', 'custom'];

/** The `--report-language` values. A custom sentence comes only from interactive init. */
export type ReportLanguageFlag = Exclude<ReportingLanguagePreset, 'custom'>;
export const REPORT_LANGUAGE_FLAG_VALUES: readonly ReportLanguageFlag[] = ['follow', 'zh-CN', 'en'];

export interface ReportingLanguage {
  readonly preset: ReportingLanguagePreset;
  readonly instruction: string;
}

export type GlobalContextHost = 'codex' | 'claude';

/** One state per file. Only the two managed states with recorded inputs sync without a flag. */
export type GlobalContextState =
  | 'missing-file'
  | 'no-rules'
  | 'legacy-unmanaged'
  | 'unbalanced'
  | 'managed-unrecorded'
  | 'managed-stale'
  | 'managed-current';

export const GLOBAL_RULES_FLAG_HINT = 'run `rh update --report-language follow|zh-CN|en`';
export const GLOBAL_RULES_UNBALANCED = 'unbalanced repo-harness markers; repair the markers manually, then re-run';

/**
 * Every section title that repo-harness ever shipped in
 * `assets/reference-configs/global-working-rules.md`. Outside the markers, a
 * section with one of these titles is replaced on sync only when its text
 * equals a released section. Every other section is user content and is kept.
 */
export const SHIPPED_GLOBAL_RULES_H1 = 'Global Working Rules';
export const SHIPPED_GLOBAL_RULES_SECTIONS: readonly string[] = [
  'Sufficiency and Stop Boundaries',
  'Progressive Due Diligence',
  'Code Optimization Principles',
  'Code Ownership',
  'No Compatibility Fallbacks in Product Code',
  'Test Budget',
  'Reporting',
  'Artifact Hygiene',
  'Completion Summary Rule',
  'Research Delegation',
  'Sub-agent Delegation',
  'Peer Harness Collaboration',
  'Review Trigger Discipline',
];

export function languageInstruction(preset: ReportingLanguagePreset, custom?: string): string {
  if (preset === 'zh-CN') return 'Use Chinese to report to user.';
  if (preset === 'en') return 'Use English to report to user.';
  if (preset === 'custom') return custom?.trim() || DEFAULT_REPORTING_INSTRUCTION;
  return DEFAULT_REPORTING_INSTRUCTION;
}

export function reportLanguageFromFlag(flag: ReportLanguageFlag): ReportingLanguage {
  return { preset: flag, instruction: languageInstruction(flag) };
}

export function parseReportLanguageFlag(value: string): ReportLanguageFlag {
  if (!REPORT_LANGUAGE_FLAG_VALUES.includes(value as ReportLanguageFlag)) {
    throw new Error(`invalid --report-language ${value}; expected ${REPORT_LANGUAGE_FLAG_VALUES.join('|')}`);
  }
  return value as ReportLanguageFlag;
}

export function globalContextPath(home: string, host: GlobalContextHost): string {
  return host === 'codex' ? join(home, '.codex', 'AGENTS.md') : join(home, '.claude', 'CLAUDE.md');
}

function readGlobalRulesTemplate(sourceRoot: string): string {
  const file = join(sourceRoot, 'assets', 'reference-configs', 'global-working-rules.md');
  const raw = readFileSync(file, 'utf-8');
  const match = raw.match(/```md\n([\s\S]*?)\n```/);
  return match?.[1] ?? raw;
}

/**
 * The completion-summary label is the one phrase in the managed block that a
 * Chinese-reporting user reads as a literal section title, so it is rendered in
 * the reporting language while the rest of the template stays English.
 */
function renderCompletionSummaryLabel(template: string, preset: ReportingLanguagePreset): string {
  if (preset !== 'zh-CN') return template;
  return template.replaceAll(COMPLETION_SUMMARY_LABEL_EN, COMPLETION_SUMMARY_LABEL_ZH);
}

/** JSON in an HTML comment; `>` is escaped so the value cannot end the comment. */
function encodeReportingLanguage(language: ReportingLanguage): string {
  const json = JSON.stringify({ preset: language.preset, instruction: language.instruction }).replaceAll('>', '\\u003e');
  return `${REPORTING_LANGUAGE_PREFIX}${json}${REPORTING_LANGUAGE_SUFFIX}`;
}

/** Returns null for any header that is absent or does not validate. It never guesses. */
function decodeReportingLanguage(line: string | undefined): ReportingLanguage | null {
  if (!line?.startsWith(REPORTING_LANGUAGE_PREFIX) || !line.endsWith(REPORTING_LANGUAGE_SUFFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(REPORTING_LANGUAGE_PREFIX.length, line.length - REPORTING_LANGUAGE_SUFFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  const { preset, instruction } = record;
  if (typeof preset !== 'string' || !REPORTING_LANGUAGE_PRESETS.includes(preset as ReportingLanguagePreset)) return null;
  if (typeof instruction !== 'string') return null;
  // A preset instruction must equal its fixed sentence; a custom one must be a
  // trimmed, non-empty sentence. languageInstruction states both rules.
  if (instruction !== languageInstruction(preset as ReportingLanguagePreset, instruction)) return null;
  return { preset: preset as ReportingLanguagePreset, instruction };
}

export function renderGlobalRulesBlock(sourceRoot: string, language: ReportingLanguage): string {
  // Write only inputs that decodeReportingLanguage accepts, so a block that
  // repo-harness writes can always be refreshed later.
  if (language.instruction !== languageInstruction(language.preset, language.instruction)) {
    throw new Error(`reporting-language instruction does not match preset ${language.preset}: ${language.instruction}`);
  }
  const template = readGlobalRulesTemplate(sourceRoot);
  const rendered = renderCompletionSummaryLabel(template, language.preset).replace(
    /^- Use the user's language for reports; keep technical terms in English\.$/m,
    () => `- ${language.instruction}`,
  );
  return [
    GLOBAL_RULES_BEGIN,
    GLOBAL_RULES_SELF_NOTE,
    encodeReportingLanguage(language),
    rendered.trim(),
    GLOBAL_RULES_END,
    '',
  ].join('\n');
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface LegacyScan {
  /** Line indexes of the legacy repo-harness span. */
  readonly removed: ReadonlySet<number>;
  /** Index of the legacy H1, else of the first removed line; null for no span. */
  readonly anchor: number | null;
  readonly replaced: readonly string[];
  readonly kept: readonly string[];
  /** Shipped titles whose text differs from every released section; they are kept. */
  readonly edited: readonly string[];
}

/**
 * Finds the legacy repo-harness span in text outside the markers: the shipped
 * H1 with its preamble up to the next heading, and each shipped `##` section
 * with its subsections up to the next `#` or `##` heading. Headings inside
 * fenced code do not count.
 */
function scanLegacySpan(lines: readonly string[]): LegacyScan {
  const removed = new Set<number>();
  const replaced: string[] = [];
  const kept: string[] = [];
  const edited: string[] = [];
  let h1Anchor: number | null = null;
  let mode: 'keep' | 'h1-preamble' | 'section' = 'keep';
  // A shipped section leaves only when its text equals a released section.
  let section: { readonly heading: string; readonly title: string; readonly lines: number[] } | null = null;
  const close = (): void => {
    if (section === null) return;
    const text = section.lines.map((index) => lines[index]!.replace(/\r?\n$/, '')).join('\n').replace(/\n+$/, '');
    if (isReleasedGlobalRulesSection(section.heading, text)) {
      for (const index of section.lines) removed.add(index);
      if (section.heading.startsWith('# ')) h1Anchor ??= section.lines[0]!;
      replaced.push(section.title);
    } else {
      edited.push(section.title);
    }
    section = null;
  };
  // CommonMark: a fence closes only on the same character with at least the
  // opening length and nothing after it.
  let fence: { readonly char: string; readonly length: number } | null = null;
  lines.forEach((line, index) => {
    const bare = line.replace(/\r?\n$/, '');
    const marker = bare.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    let fenceLine = false;
    if (fence === null && marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      fenceLine = true;
    } else if (fence !== null && marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') {
      fence = null;
      fenceLine = true;
    }
    const heading = fence === null && !fenceLine ? bare.match(/^(#{1,6}) (.+?)\s*$/) : null;
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      if (level === 1 && title === SHIPPED_GLOBAL_RULES_H1) {
        close();
        mode = 'h1-preamble';
        section = { heading: `# ${title}`, title, lines: [] };
      } else if (level === 2 && SHIPPED_GLOBAL_RULES_SECTIONS.includes(title)) {
        close();
        mode = 'section';
        section = { heading: `## ${title}`, title, lines: [] };
      } else if (level <= 2 || mode === 'h1-preamble') {
        close();
        mode = 'keep';
        if (level <= 2) kept.push(title);
      }
    }
    if (mode !== 'keep') section!.lines.push(index);
  });
  close();
  const first = removed.size > 0 ? Math.min(...removed) : null;
  return { removed, anchor: h1Anchor ?? first, replaced: [...new Set(replaced)], kept, edited: [...new Set(edited)] };
}

function keptText(lines: readonly string[], scan: LegacyScan, from: number, to: number): string {
  return lines.slice(from, to).filter((_, offset) => !scan.removed.has(from + offset)).join('');
}

export type ManagedBlockStatus = 'written' | 'blocked-unbalanced' | 'kept-edited';

export interface MergedManagedBlock {
  readonly content: string;
  readonly status: ManagedBlockStatus;
  /** Shipped titles removed from outside the markers. */
  readonly replaced: readonly string[];
  /** User section titles kept outside the markers. */
  readonly kept: readonly string[];
  /** Shipped section titles kept outside the markers because their text differs from every released section. */
  readonly edited: readonly string[];
}

/**
 * The marked block is repo-harness's only when its text equals a released
 * block or the current rendering of its own recorded inputs.
 */
function managedBlockProved(block: string, sourceRoot: string): boolean {
  const lines = block.split('\n');
  const language = isSelfNote(lines[1]) ? decodeReportingLanguage(lines[2]) : null;
  // The released fingerprints need no template, so a released block is proved even when the template is unreadable.
  if (isReleasedGlobalRulesBlock(block, language?.preset === 'custom' ? language.instruction : null)) return true;
  return language !== null && block === renderGlobalRulesBlock(sourceRoot, language).trimEnd();
}

/** The ledger's text of rh's block in one file; null when the ledger has no record of it. */
export type GlobalRulesRecord = string | null;

/**
 * One authority proves that the marked block is rh's. A file that the
 * host-config ledger records: the block must equal the recorded text. A file
 * with no record: the block must equal a released block or the rendering of
 * its own inputs.
 */
function blockProved(raw: string, recorded: GlobalRulesRecord, sourceRoot: string): boolean {
  return recorded !== null ? raw === recorded : managedBlockProved(raw.replace(/\r\n/g, '\n'), sourceRoot);
}

/**
 * Repo-harness rules are overwritten; user rules are kept. Outside the markers,
 * a shipped section leaves only when its text equals a released section. An
 * existing block is refreshed in place only when it is proved rh's; an
 * edited block keeps the whole file unchanged. Otherwise the block goes where
 * the legacy H1 was, or at the end of a file without a legacy span
 * (`insertMarkedBlock`). Every other line keeps its bytes and order.
 */
export function mergeManagedBlock(current: string, renderedBlock: string, sourceRoot: string, recorded: GlobalRulesRecord = null): MergedManagedBlock {
  // A CRLF file keeps CRLF: the block is written in the file's line ending,
  // so the current/stale compare is byte-exact and a second sync is a no-op.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const block = eol === '\n' ? renderedBlock : renderedBlock.replace(/\r?\n/g, eol);
  const layout = markedBlockLayout(current, GLOBAL_RULES_SELECTOR);
  if (layout.kind === 'unbalanced') return { content: current, status: 'blocked-unbalanced', replaced: [], kept: [], edited: [] };
  if (layout.kind === 'balanced') {
    const raw = current.slice(layout.start, layout.end);
    if (raw !== block.trimEnd() && !blockProved(raw, recorded, sourceRoot)) {
      return { content: current, status: 'kept-edited', replaced: [], kept: [], edited: [] };
    }
    const beforeLines = splitLines(current.slice(0, layout.start));
    const afterLines = splitLines(current.slice(layout.end));
    const before = scanLegacySpan(beforeLines);
    const after = scanLegacySpan(afterLines);
    const merged = `${keptText(beforeLines, before, 0, beforeLines.length)}${block.trimEnd()}${
      keptText(afterLines, after, 0, afterLines.length)}`;
    return {
      content: merged,
      status: 'written',
      replaced: [...new Set([...before.replaced, ...after.replaced])],
      kept: [...before.kept, ...after.kept],
      edited: [...new Set([...before.edited, ...after.edited])],
    };
  }
  const lines = splitLines(current);
  const scan = scanLegacySpan(lines);
  if (scan.anchor === null) {
    const edit = insertMarkedBlock(current, block.trimEnd());
    return { content: applyEdit(current, edit), status: 'written', replaced: [], kept: scan.kept, edited: scan.edited };
  }
  const before = keptText(lines, scan, 0, scan.anchor);
  const after = keptText(lines, scan, scan.anchor, lines.length);
  return {
    content: `${before}${block}${after ? `${eol}${after}` : ''}`,
    status: 'written',
    replaced: scan.replaced,
    kept: scan.kept,
    edited: scan.edited,
  };
}

function applyEdit(content: string, edit: FragmentEdit): string {
  return content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
}

/** True when text outside the markers holds a legacy repo-harness span. */
function hasLegacySpan(content: string): boolean {
  const layout = markedBlockLayout(content, GLOBAL_RULES_SELECTOR);
  if (layout.kind === 'unbalanced') return false;
  if (layout.kind === 'none') return scanLegacySpan(splitLines(content)).anchor !== null;
  return scanLegacySpan(splitLines(content.slice(0, layout.start))).anchor !== null
    || scanLegacySpan(splitLines(content.slice(layout.end))).anchor !== null;
}

export function formatMigratedLegacy(path: string, merged: MergedManagedBlock): string {
  return `migrated-legacy:${path} (replaced: ${merged.replaced.join(', ')}; kept user sections: ${merged.kept.join(', ') || 'none'})`;
}

export interface GlobalContextInspection {
  readonly state: GlobalContextState;
  /** The recorded render inputs; present only for managed-stale and managed-current. */
  readonly language: ReportingLanguage | null;
  /** True when text outside the markers holds a legacy repo-harness span. */
  readonly legacySpan: boolean;
  /** The sync with the recorded inputs; present with `language`. */
  readonly synced: MergedManagedBlock | null;
}

/**
 * Classifies one file. `content` is null when the file does not exist. The
 * template is read only for a block with valid recorded inputs; a read error
 * there propagates to the caller. A balanced block with a legacy span outside
 * it is managed; the span makes a recorded block stale.
 */
export function inspectGlobalContext(content: string | null, sourceRoot: string, recorded: GlobalRulesRecord = null): GlobalContextInspection {
  if (content === null) return { state: 'missing-file', language: null, legacySpan: false, synced: null };
  const layout = markedBlockLayout(content, GLOBAL_RULES_SELECTOR);
  const legacySpan = hasLegacySpan(content);
  const unsynced = (state: GlobalContextState): GlobalContextInspection => ({ state, language: null, legacySpan, synced: null });
  if (layout.kind === 'unbalanced') return unsynced('unbalanced');
  if (layout.kind === 'none') return unsynced(legacySpan ? 'legacy-unmanaged' : 'no-rules');
  const blockLines = content.slice(layout.start, layout.end).split(/\r?\n/);
  const language = isSelfNote(blockLines[1]) ? decodeReportingLanguage(blockLines[2]) : null;
  if (language === null) return unsynced('managed-unrecorded');
  const synced = mergeManagedBlock(content, renderGlobalRulesBlock(sourceRoot, language), sourceRoot, recorded);
  const current = synced.status !== 'kept-edited' && synced.content === content;
  return { state: current ? 'managed-current' : 'managed-stale', language, legacySpan, synced };
}

export interface GlobalContextFilePlan {
  readonly path: string;
  readonly state: GlobalContextState | 'unreadable';
  readonly outcome: 'write' | 'unchanged' | 'skipped';
  /** The file content at preflight; null when the file did not exist. */
  readonly current: string | null;
  readonly recorded: GlobalRulesRecord;
  /** The rendered block to write; set only when `outcome` is `write`. */
  readonly block: string | null;
  /** True when the write also takes out legacy sections outside the markers. */
  readonly legacy: boolean;
  readonly detail: string;
  /** True when the managed block differs from every released block and sync keeps it. */
  readonly edited?: true;
}

/**
 * The per-file write detail. A removed legacy span is named with the kept user
 * sections; a kept edited shipped section is named too.
 */
export function formatGlobalContextWrite(path: string, current: string | null, merged: MergedManagedBlock): string {
  const edited = merged.edited.length > 0
    ? ` (kept edited sections: ${merged.edited.join(', ')}; they differ from every released section, so sync does not change them)`
    : '';
  if (merged.replaced.length > 0) return `${formatMigratedLegacy(path, merged)}${edited}`;
  if (merged.content === current) return `unchanged:${path}${edited}`;
  return `${current === null ? 'created' : current.includes(GLOBAL_RULES_BEGIN) ? 'updated' : 'appended'}:${path}${edited}`;
}

export const GLOBAL_RULES_EDITED = 'the managed block differs from every released block, so sync keeps it; move personal rules outside the markers, then delete the block with both markers and run `rh update --report-language follow|zh-CN|en` to get the current one';

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * True for a readable regular file, false for a missing one; the user's links
 * are followed (#2841 Part B). Throws for any other entry, so a FIFO or
 * special file is never opened for reading.
 */
function readableGlobalContextFile(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error('not a regular file');
  accessSync(path, constants.R_OK);
  return true;
}

function readGlobalContextFile(path: string): string | null {
  return readableGlobalContextFile(path) ? readFileSync(path, 'utf-8') : null;
}

/**
 * The host transaction backs up a rules path only when the copy cannot fail:
 * a missing path, a symlink (copied verbatim), or a readable regular file.
 * Any other path is left out of the backup, and the plan never writes it.
 */
export function globalContextBackupEligible(path: string): boolean {
  try {
    const stat = lstatOrNull(path);
    if (stat === null || stat.isSymbolicLink()) return true;
    return readableGlobalContextFile(path);
  } catch {
    return false;
  }
}

/** The gate reads its ledger under HOME; the rules writers know only HOME. */
function rulesGate(home: string): HostConfigGate {
  return openHostConfigGate({ env: { ...process.env, HOME: home } });
}

function recordedBlock(gate: HostConfigGate, path: string): GlobalRulesRecord {
  return gate.recorded(path).find((record) => record.selector === GLOBAL_RULES_SELECTOR)?.inserted ?? null;
}

/**
 * Plans one file for install or update. It is read-only. A valid recorded
 * header wins over the flag; without a header the flag supplies the inputs.
 * A file that cannot be synced is skipped with the next command; it never
 * stops the run, so an older parent CLI without the flag can still update.
 */
export function planGlobalContextFile(
  path: string,
  home: string,
  sourceRoot: string,
  flag: ReportLanguageFlag | undefined,
): GlobalContextFilePlan {
  const unreadable = (current: string | null, detail: string): GlobalContextFilePlan => (
    { path, state: 'unreadable', outcome: 'skipped', current, recorded: null, block: null, legacy: false, detail }
  );
  let current: string | null;
  let recorded: GlobalRulesRecord;
  try {
    current = readGlobalContextFile(path);
    recorded = recordedBlock(rulesGate(home), path);
  } catch (error) {
    return unreadable(null, `skipped-unreadable:${path} (${(error as Error).message}; make it a readable regular file to enable managed sync)`);
  }
  let inspection: GlobalContextInspection;
  try {
    inspection = inspectGlobalContext(current, sourceRoot, recorded);
  } catch (error) {
    return unreadable(current, `skipped-template:${path} (cannot render the Global Working Rules template: ${(error as Error).message}; reinstall repo-harness)`);
  }
  const plan = (outcome: GlobalContextFilePlan['outcome'], detail: string): GlobalContextFilePlan => (
    { path, state: inspection.state, outcome, current, recorded, block: null, legacy: false, detail }
  );
  const write = (merged: MergedManagedBlock, block: string): GlobalContextFilePlan => merged.status === 'kept-edited'
    ? { ...plan('skipped', `skipped-edited:${path} (${GLOBAL_RULES_EDITED})`), edited: true }
    : { ...plan('write', formatGlobalContextWrite(path, current, merged)), block, legacy: merged.replaced.length > 0 };
  const withFlag = (): GlobalContextFilePlan => {
    const block = renderGlobalRulesBlock(sourceRoot, reportLanguageFromFlag(flag!));
    return write(mergeManagedBlock(current ?? '', block, sourceRoot, recorded), block);
  };
  switch (inspection.state) {
    case 'managed-current':
      return plan('unchanged', formatGlobalContextWrite(path, current, inspection.synced!));
    case 'managed-stale':
      return write(inspection.synced!, renderGlobalRulesBlock(sourceRoot, inspection.language!));
    case 'unbalanced':
      return plan('skipped', `skipped-unbalanced:${path} (${GLOBAL_RULES_UNBALANCED})`);
    case 'managed-unrecorded':
      return flag
        ? withFlag()
        : plan('skipped', `skipped-unrecorded:${path} (managed block has no recorded reporting language; ${GLOBAL_RULES_FLAG_HINT})`);
    case 'legacy-unmanaged':
      return flag
        ? withFlag()
        : plan('skipped', `skipped-legacy:${path} (legacy repo-harness rules without markers; ${GLOBAL_RULES_FLAG_HINT}; user sections are kept)`);
    case 'no-rules':
    case 'missing-file':
      return flag
        ? withFlag()
        : plan('skipped', `skipped-not-opted-in:${path} (not opted in; ${GLOBAL_RULES_FLAG_HINT} to install the rules)`);
  }
}

export interface GlobalContextRefreshPlan {
  /** The package whose template and released values prove an unrecorded block. */
  readonly sourceRoot: string;
  readonly files: readonly GlobalContextFilePlan[];
}

/** Read-only. It runs before any host write and plans each selected file. */
export function preflightGlobalContextRefresh(
  sourceRoot: string,
  home: string,
  hosts: readonly GlobalContextHost[],
  flag: ReportLanguageFlag | undefined,
): GlobalContextRefreshPlan {
  return { sourceRoot, files: hosts.map((host) => planGlobalContextFile(globalContextPath(home, host), home, sourceRoot, flag)) };
}

/** Explicit owner change: recorded presets do not override this request. */
export function setReportingLanguage(
  home: string,
  sourceRoot: string,
  hosts: readonly GlobalContextHost[],
  preset: ReportLanguageFlag,
): GlobalContextRefresh & { readonly changed_hosts: readonly GlobalContextHost[]; readonly edited?: true } {
  const plan = preflightGlobalContextRefresh(sourceRoot, home, hosts, preset);
  const refused = plan.files.find(file => file.outcome === 'skipped');
  if (refused) return { status: 'skipped', detail: refused.detail, changed_hosts: [], ...(refused.edited && { edited: true as const }) };
  const block = renderGlobalRulesBlock(sourceRoot, reportLanguageFromFlag(preset));
  const files = plan.files.map((file): GlobalContextFilePlan => {
    const merged = mergeManagedBlock(file.current ?? '', block, sourceRoot, file.recorded);
    const changed = merged.content !== file.current;
    return { ...file, outcome: changed ? 'write' : 'unchanged', block: changed ? block : null, legacy: merged.replaced.length > 0,
      detail: formatGlobalContextWrite(file.path, file.current, merged) };
  });
  const result = applyGlobalContextRefresh({ sourceRoot, files }, home);
  return { ...result, changed_hosts: result.status === 'ok' ? hosts.filter((_, index) => files[index]!.outcome === 'write') : [] };
}

export interface GlobalContextRefresh {
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail: string;
}

/**
 * The gate's strategy for the rules block. `locate` is the shared marked-block
 * boundary, so the ledger records the block text that a revert compares.
 * `apply` makes the `mergeManagedBlock` decision on the bytes that the gate
 * read and returns one edit: a plain refresh replaces exactly the old block,
 * so the edit removes the recorded text; a legacy migration spans every
 * changed byte. A block that is now edited or unbalanced fails: the file
 * changed after preflight.
 */
function globalRulesStrategy(sourceRoot: string, recorded: GlobalRulesRecord): HostConfigStrategy<string> {
  return {
    locate: markedBlock.locate,
    apply(content, selector, block) {
      const merged = mergeManagedBlock(content, block, sourceRoot, recorded);
      if (merged.status !== 'written') throw new HostConfigError('host_config_target_changed', `the ${selector} block changed after preflight; re-run`);
      const old = markedBlockLayout(content, selector);
      let prefix = 0;
      const shorter = Math.min(content.length, merged.content.length);
      while (prefix < shorter && content[prefix] === merged.content[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < shorter - prefix && content[content.length - 1 - suffix] === merged.content[merged.content.length - 1 - suffix]) suffix += 1;
      if (old.kind === 'balanced') {
        prefix = Math.min(prefix, old.start);
        suffix = Math.min(suffix, content.length - old.end);
      }
      return { at: prefix, removed: content.slice(prefix, content.length - suffix), inserted: merged.content.slice(prefix, merged.content.length - suffix) };
    },
  };
}

/**
 * Writes the preflight plan through the host-config gate. rh's own add and
 * refresh keep no whole-file copy (`overrides-only`, owner C1 on #2849); a
 * legacy migration takes out text that the ledger does not hold, so the gate
 * keeps the file in its vault first. Two host paths that name one file are
 * written once. Status is ok only when every file is current or written,
 * skipped when a file was not synced, and failed only for an error here.
 */
export function applyGlobalContextRefresh(plan: GlobalContextRefreshPlan, home: string): GlobalContextRefresh {
  const details: string[] = [];
  let failed = false;
  let skipped = plan.files.some((file) => file.outcome === 'skipped');
  const gate = rulesGate(home);
  const paths = hostConfigPaths({ ...process.env, HOME: home });
  const written = new Map<string, string>();
  for (const file of plan.files) {
    if (file.outcome !== 'write') {
      details.push(file.detail);
      continue;
    }
    try {
      const target = resolveHostPath(paths, file.path);
      const first = written.get(target);
      if (first !== undefined) {
        details.push(`${file.detail} (same file as ${first})`);
        continue;
      }
      written.set(target, file.path);
      // The write detail describes the preflight bytes; other bytes need a new plan.
      if (readGlobalContextFile(file.path) !== file.current) {
        failed = true;
        details.push(`failed:${file.path} (changed after preflight; re-run)`);
        continue;
      }
      adoptGlobalRulesBlock(gate, file.path, plan.sourceRoot);
      const recorded = recordedBlock(gate, file.path);
      const kind = file.current !== null && markedBlockLayout(file.current, GLOBAL_RULES_SELECTOR).kind === 'balanced' ? 'refresh' : 'add';
      const result = gate.apply([{
        path: file.path,
        backup: 'overrides-only',
        fragments: [{
          owner: GLOBAL_RULES_OWNER,
          selector: GLOBAL_RULES_SELECTOR,
          kind,
          strategy: globalRulesStrategy(plan.sourceRoot, recorded),
          value: file.block!,
          // Selected: released rh sections outside the markers, which the plan proved but the ledger does not hold; or
          // a block that the user deleted after rh recorded it, which only the --report-language flag writes again.
          ...(file.legacy || (kind === 'add' && recorded !== null) ? { selected: true } : {}),
        }],
      }]);
      if (result.skipped.length) {
        skipped = true;
        details.push(`skipped-edited:${file.path} (${GLOBAL_RULES_EDITED})`);
      } else details.push(file.detail);
    } catch (error) {
      failed = true;
      details.push(`failed:${file.path} (${(error as Error).message})`);
    }
  }
  return { status: failed ? 'failed' : skipped ? 'skipped' : 'ok', detail: details.join(', ') };
}

/**
 * One-shot migration (#2849): an rh version before the ledger wrote the block
 * with no record. A proved block becomes an `add` fragment; the file is
 * `created` when nothing but the block is in it. No whole-file copy is kept
 * (owner C1). Null for a file with no proved block.
 */
export function planGlobalRulesAdoption(content: string | null, sourceRoot: string): HostConfigAdoption | null {
  if (content === null) return null;
  const layout = markedBlockLayout(content, GLOBAL_RULES_SELECTOR);
  if (layout.kind !== 'balanced') return null;
  const inserted = content.slice(layout.start, layout.end);
  if (!managedBlockProved(inserted.replace(/\r\n/g, '\n'), sourceRoot)) return null;
  const rest = applyEdit(content, removeMarkedBlock(content, GLOBAL_RULES_SELECTOR));
  return {
    kind: rest.trim() === '' ? 'created' : 'text_block',
    backup: null,
    // The preimage lets a failed install put back the block that it adopted and then refreshed.
    fragments: [{ owner: GLOBAL_RULES_OWNER, selector: GLOBAL_RULES_SELECTOR, kind: 'add', inserted, preimage: inserted }],
    externalChange: false,
  };
}

/** Adopts the block of one rules file that the ledger does not hold yet; a recorded file keeps its record. */
function adoptGlobalRulesBlock(gate: HostConfigGate, path: string, sourceRoot: string): void {
  const adoption = planGlobalRulesAdoption(readGlobalContextFile(path), sourceRoot);
  if (adoption) gate.adopt(path, adoption);
}

/** What uninstall does with a rules file that the ledger does not hold. */
export type UnrecordedGlobalRules =
  | { readonly kind: 'none' }
  | { readonly kind: 'adopt'; readonly adoption: HostConfigAdoption }
  | { readonly kind: 'preserved'; readonly reason: string };

export function inspectUnrecordedGlobalRules(path: string, sourceRoot: string): UnrecordedGlobalRules {
  const content = readGlobalContextFile(path);
  if (content === null) return { kind: 'none' };
  const layout = markedBlockLayout(content, GLOBAL_RULES_SELECTOR);
  if (layout.kind === 'none') return { kind: 'none' };
  if (layout.kind === 'unbalanced') return { kind: 'preserved', reason: 'unbalanced managed global rules; preserved' };
  const adoption = planGlobalRulesAdoption(content, sourceRoot);
  return adoption
    ? { kind: 'adopt', adoption }
    : { kind: 'preserved', reason: 'managed rules block was edited; preserved. Move your rules outside the markers, then delete the block.' };
}

/** The revert of an adoption that a dry run has not written: the same plan as `revert` after the migration. */
export function previewGlobalRulesAdoptedRevert(path: string, adoption: HostConfigAdoption): HostConfigRevertEntry {
  const bytes = readFileSync(path);
  const records = adoption.fragments.map((fragment) => ({ file: path, ...fragment }));
  return planFileRevert({
    path, kind: adoption.kind ?? 'text_block', hasBackup: false, externalChange: false,
    committed: true, existed: true, bytes, backup: () => { throw new Error('an adopted rules file has no backup'); }, own: records, all: records, filtered: false,
  }).entry;
}
