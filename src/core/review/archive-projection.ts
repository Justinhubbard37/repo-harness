import { canonicalize } from '../evidence/canonical-json';
import { sha256Prefixed } from '../evidence/sha256';

function fail(message: string, code = 1): never {
  const error = new Error(message) as Error & { exitCode?: number };
  error.exitCode = code;
  throw error;
}

type ArchiveProjectionKind = 'plan' | 'contract' | 'review' | 'notes';

type ArchiveProjectionEntry = {
  source: string;
  destination: string;
  kind: ArchiveProjectionKind;
};

type ParsedArchiveProjection = {
  body: string;
  entries: ArchiveProjectionEntry[];
  lifecycle: ArchiveProjectionKind;
  relatedPlan: string;
  manifestSha256: string;
};

function archiveProjectionKind(path: string, archived: boolean): ArchiveProjectionKind | null {
  const patterns: Array<[ArchiveProjectionKind, RegExp]> = archived
    ? [
        ['plan', /^plans\/archive\/plan-[^`\r\n]+\.md$/],
        ['contract', /^tasks\/archive\/contract-[^`\r\n]+\.md$/],
        ['review', /^tasks\/archive\/review-[^`\r\n]+\.md$/],
        ['notes', /^tasks\/archive\/notes-[^`\r\n]+\.md$/],
      ]
    : [
        ['plan', /^plans\/plan-[^`\r\n]+\.md$/],
        ['contract', /^tasks\/contracts\/[^`\r\n]+\.contract\.md$/],
        ['review', /^tasks\/reviews\/[^`\r\n]+\.review\.md$/],
        ['notes', /^tasks\/notes\/[^`\r\n]+\.notes\.md$/],
      ];
  return patterns.find(([, pattern]) => pattern.test(path))?.[0] ?? null;
}

function parseArchiveProjection(content: string): ParsedArchiveProjection | null {
  const projectionMarker = '> **Archive Projection V1**:';
  const archiveEnvelope = /^(?<envelope>> \*\*Archived\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\r?\n> \*\*Related Plan\*\*: (?<relatedPlan>plans\/archive\/[^\r\n]+)\r?\n> \*\*Outcome\*\*: (?:Completed|Abandoned|Superseded)\r?\n> \*\*Lifecycle\*\*: (?<lifecycle>plan|contract|review|notes)\r?\n> \*\*Parent Run ID\*\*: [^\s\r\n]+\r?\n(?<projection>(?:> \*\*Archive Projection V1\*\*: `[^`\r\n]+` => `[^`\r\n]+`\r?\n)*)\r?\n)/;
  const envelope = archiveEnvelope.exec(content);
  if (!envelope) {
    if (content.includes(projectionMarker)) fail('archive projection envelope is malformed');
    return null;
  }

  const projectionText = envelope.groups?.projection ?? '';
  if (projectionText === '') return null;

  const entries: ArchiveProjectionEntry[] = [];
  const linePattern = /^> \*\*Archive Projection V1\*\*: `([^`\r\n]+)` => `([^`\r\n]+)`\r?$/gm;
  for (const match of projectionText.matchAll(linePattern)) {
    const source = match[1];
    const destination = match[2];
    const sourceKind = archiveProjectionKind(source, false);
    const destinationKind = archiveProjectionKind(destination, true);
    if (sourceKind === null || destinationKind === null || sourceKind !== destinationKind) {
      fail('archive projection entry crosses an unsupported workflow family');
    }
    entries.push({ source, destination, kind: sourceKind });
  }
  if (entries.length === 0 || entries.length !== projectionText.trimEnd().split(/\r?\n/).length) {
    fail('archive projection entries are malformed');
  }
  if (new Set(entries.map((entry) => entry.source)).size !== entries.length
    || new Set(entries.map((entry) => entry.destination)).size !== entries.length) {
    fail('archive projection entries must be one-to-one');
  }
  const planEntry = entries.find((entry) => entry.kind === 'plan');
  if (!planEntry || planEntry.destination !== envelope.groups?.relatedPlan) {
    fail('archive projection related plan is inconsistent');
  }
  const lifecycle = envelope.groups?.lifecycle as ArchiveProjectionKind;
  if (!entries.some((entry) => entry.kind === lifecycle)) {
    fail('archive projection does not contain its lifecycle artifact');
  }

  let normalized = content.slice(envelope[0].length);
  for (const entry of [...entries].sort((left, right) => right.destination.length - left.destination.length)) {
    normalized = normalized.replaceAll(entry.destination, entry.source);
  }
  const canonicalEntries = [...entries].sort((left, right) => left.source.localeCompare(right.source));
  return {
    body: normalized,
    entries,
    lifecycle,
    relatedPlan: envelope.groups?.relatedPlan ?? '',
    manifestSha256: sha256Prefixed(canonicalize({ protocol: 1, entries: canonicalEntries })),
  };
}

function normalizeArchiveProjection(content: string): string {
  const parsed = parseArchiveProjection(content);
  if (parsed) return parsed.body;
  const legacyEnvelope = /^> \*\*Archived\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\r?\n> \*\*Related Plan\*\*: plans\/archive\/[^\r\n]+\r?\n> \*\*Outcome\*\*: (?:Completed|Abandoned|Superseded)\r?\n> \*\*Lifecycle\*\*: (?:contract|review|notes)\r?\n> \*\*Parent Run ID\*\*: [^\s\r\n]+\r?\n\r?\n/;
  return content.replace(legacyEnvelope, '');
}

export function authorityFingerprint(content: string): string {
  const normalized = normalizeArchiveProjection(content)
    .replace(/^> \*\*Status\*\*:[ \t]*.+$/m, '> **Status**: <lifecycle>')
    .replace(/^> \*\*Last Updated\*\*:[ \t]*.+$/m, '> **Last Updated**: <lifecycle>');
  return sha256Prefixed(normalized);
}

export function contractCarriesArchiveProjection(content: string): boolean {
  return parseArchiveProjection(content) !== null;
}
