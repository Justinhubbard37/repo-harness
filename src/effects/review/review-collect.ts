import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { hcGet, RH_LABEL } from '../terminal/herdr-core';
import { piAgentDir } from '../pi-agent-dir';
import { osAccountHome } from '../runtime/os-account-home';
import { parseReviewPacket } from '../../core/board/review';
import { errorMessage } from '../../core/evidence/error-message';
import {
  parseReceipt, publishReceipt, readPrHeadSha, ReviewPublishError, type ReviewPublishInput, type ReviewPublishResult,
} from './review-publish';

const MARKER = 'RECEIPT-JSON';
const RECEIPT_KIND = 'repo-harness-review-publish-receipt';

export interface ReviewCollectInput extends ReviewPublishInput {
  /** The review seat's `hc` terminal address (Pi, Claude or Codex). */
  readonly seat: string;
}

const invalid = (message: string) => new ReviewPublishError('review_receipt_invalid', message, 2);

/** The directory pi-coding-agent's `getDefaultSessionDirPath` names: agent dir, `sessions`, then the cwd without its leading separator, `/`, `\` and `:` as `-`, wrapped in `--`. */
function piSessionDirectory(agentDir: string, cwd: string): string {
  return join(agentDir, 'sessions', '--' + resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
}

/** Claude Code keeps a project's sessions under `projects/<cwd with every non-alphanumeric as '-'>`. */
function claudeSessionDirectory(configDir: string, cwd: string): string {
  return join(configDir, 'projects', resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

const envDirectory = (name: string, fallback: string): string => {
  const configured = process.env[name];
  return configured === undefined || configured === '' ? fallback : configured;
};

function jsonlIn(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** The first line of a file, read in chunks: a Codex `session_meta` line carries the whole base instructions. */
function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let text = '';
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0 && !text.includes('\n'); read = readSync(fd, chunk, 0, chunk.length, null)) text += chunk.toString('utf8', 0, read);
    return text.split('\n')[0]!;
  } finally { closeSync(fd); }
}

/** Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl` for every working directory; the `session_meta` line names the one of each. */
function codexSessionFiles(codexHome: string, cwd: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          const meta = JSON.parse(firstLine(path));
          if (meta?.type === 'session_meta' && typeof meta.payload?.cwd === 'string' && realpathSync(meta.payload.cwd) === cwd) found.push(path);
        } catch { /* a file that is no rollout of this working directory */ }
      }
    }
  };
  walk(join(codexHome, 'sessions'));
  return found;
}

interface SessionRecord { readonly path: string; readonly packet: string; readonly assistant: readonly string[] }

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (typeof part?.text === 'string' && ['text', 'input_text', 'output_text'].includes(part.type) ? [part.text] : []));
}

/** Pi and Claude Code write `{ message: { role, content } }`; Codex writes `{ type: 'response_item', payload: { type: 'message', role, content } }`. */
function messageOf(entry: any): { role?: unknown; content?: unknown } | undefined {
  return entry?.type === 'response_item' && entry.payload?.type === 'message' ? entry.payload : entry?.message;
}

function readSession(path: string): SessionRecord {
  let packet = '';
  const assistant: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = messageOf(entry);
    if (message?.role === 'user' && packet === '') {
      // Other user entries (hooks, AGENTS.md) come before the task; the packet is the first one that parses as a packet.
      const text = textOf(message.content).join('\n');
      if (parseReviewPacket(text) !== null) packet = text;
    } else if (message?.role === 'assistant') assistant.push(...textOf(message.content));
  }
  return { path, packet, assistant };
}

/** The JSON value that starts right after a marker (past an optional code fence); the decoder, not a fence regex, finds where it ends. */
function decodeAfterMarker(text: string, markerEnd: number): unknown {
  const rest = text.slice(markerEnd).replace(/^:?\s*(```[a-z]*)?\s*/, '');
  if (!rest.startsWith('{') && !rest.startsWith('[')) return undefined;
  for (let end = 0; end < rest.length; end++) {
    if (rest[end] !== '}' && rest[end] !== ']') continue;
    try { return JSON.parse(rest.slice(0, end + 1)); } catch { /* the value ends later */ }
  }
  return undefined;
}

/** The last value after any marker that decodes to a receipt object; a marker inside a string decodes to nothing and is skipped. */
function lastReceiptValue(texts: readonly string[]): unknown {
  let marked = false;
  let found: unknown;
  for (const text of texts) {
    for (let at = text.indexOf(MARKER); at >= 0; at = text.indexOf(MARKER, at + MARKER.length)) {
      marked = true;
      const value = decodeAfterMarker(text, at + MARKER.length);
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === RECEIPT_KIND) found = value;
    }
  }
  if (!marked) throw invalid('the seat session has no ' + MARKER + ' block');
  if (found === undefined) throw invalid('no ' + MARKER + ' block decodes to a ' + RECEIPT_KIND + ' object');
  return found;
}

/**
 * The session of the seat is the one whose packet names this seat, this PR and the PR head now. Review seats of one PR share a
 * worktree, so one directory holds every seat and every round, and file age says nothing about either. Sessions of an earlier head
 * are not candidates; two sessions for the head, or a receipt for another head than its packet's, fail closed.
 */
export function collectReview(input: ReviewCollectInput): ReviewPublishResult {
  const terminal = hcGet(input.seat);
  const cwd = terminal.cwd;
  if (cwd == null) throw invalid('terminal ' + input.seat + ' reports no working directory');
  const seat = terminal.labels[RH_LABEL.seat];
  if (seat === undefined) throw invalid('terminal ' + input.seat + ' carries no ' + RH_LABEL.seat + ' label; launch the seat with `rh seats argv <seat> --repository-id <id> --pr <n>`');
  let realCwd: string;
  try { realCwd = realpathSync(cwd); } catch (error) { throw invalid('the seat working directory is unreadable: ' + errorMessage(error)); }
  const home = osAccountHome();
  const piDirectory = piSessionDirectory(piAgentDir(home), realCwd);
  const claudeDirectory = claudeSessionDirectory(envDirectory('CLAUDE_CONFIG_DIR', join(home, '.claude')), realCwd);
  const files = [...jsonlIn(piDirectory), ...jsonlIn(claudeDirectory), ...codexSessionFiles(envDirectory('CODEX_HOME', join(home, '.codex')), realCwd)];
  const bound = files.map(readSession).filter((session) => {
    const packet = parseReviewPacket(session.packet);
    return packet !== null && packet.pr === input.prNumber && packet.seat === seat;
  });
  if (bound.length === 0) {
    throw invalid('the seat session record is missing: no session in ' + piDirectory + ', in ' + claudeDirectory + ' or in a Codex rollout of ' + realCwd + ' holds the review packet of the ' + seat + ' for PR #' + input.prNumber);
  }
  const head = readPrHeadSha(input);
  const atHead = bound.filter((session) => parseReviewPacket(session.packet)!.head_sha === head);
  if (atHead.length === 0) {
    throw new ReviewPublishError('review_subject_stale', 'no session of the ' + seat + ' for PR #' + input.prNumber + ' holds a packet for the PR head ' + head + '; nothing was posted', 2);
  }
  // A session that ends with no receipt (an aborted attempt) is no candidate and makes nothing ambiguous.
  const finished = atHead.flatMap((session) => {
    try { return [{ session, receipt: parseReceipt(lastReceiptValue(session.assistant)) }]; } catch { return []; }
  });
  if (finished.length > 1) throw invalid(finished.length + ' sessions of the ' + seat + ' for PR #' + input.prNumber + ' end with a receipt for the PR head ' + head + ': ' + finished.map(({ session }) => session.path).join(', '));
  // The one session at the head reports its own error when it holds no valid receipt.
  const receipt = finished.length === 1 ? finished[0]!.receipt : parseReceipt(lastReceiptValue(atHead[0]!.assistant));
  if (receipt.subject_sha !== head) throw invalid('the receipt names ' + receipt.subject_sha + ', not the packet head ' + head);
  return publishReceipt(input, receipt);
}
