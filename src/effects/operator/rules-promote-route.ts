import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROUTING_CLASSES, type RoutingClass } from '../../core/board/seats-settings';
import { RULES_PROMOTE_KIND } from '../../core/ci/rule-prompt';
import { sha256Hex } from '../../core/evidence/sha256';
import type { JsonValue } from '../../core/evidence/types';
import { isRulesPromptText } from '../../core/operator/rules';
import { withoutRepositorySelectingGitEnv } from '../git/runner';
import { readRepoHarnessRegistryStrictSnapshot } from '../repo-registry';
import type { BoardCliAdmission } from './advisor-seat-route';
import { RULES_CLI_ENTRY, runRulesProcess, type RulesProcessRunner } from './rules-collector';
import { prepareOperatorStateDir } from './write-audit';
import type { OperatorWriteRoute } from './write-channel';
import { OperatorWriteRefusal, operatorWriteError, type OperatorWriteResponse } from './write-run';

/**
 * The two console writes of a rules promotion (#2889). Each one runs
 * `rh rules promote` in a child process, so the CLI stays the one owner of the
 * GitHub calls and of the duplicate check; the server holds no credential and
 * never starts a board or merge command.
 */
export const OPERATOR_RULES_PROMOTIONS_ROUTE = /^\/api\/v1\/repositories\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/rules\/promotions$/u;
export const OPERATOR_RULES_RECONCILE_ROUTE = /^\/api\/v1\/repositories\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/rules\/promotions\/reconcile$/u;
/** Each GitHub call of the CLI has a 30 s bound; a promotion makes at most eight. */
export const RULES_PROMOTE_TIMEOUT_MS = 240_000;

const CANDIDATE = /^[0-9a-f]{64}$/u;
const BLOB = /^[0-9a-f]{40,64}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/u;
const RECONCILE_NEXT = 'Run the reconcile of this candidate before you send a new request.';
const REFRESH_NEXT = 'Refresh the rules page, then send a new request_id.';

const refusal = (status: number, code: string, message: string, nextAction: string) => new OperatorWriteRefusal(status, code, message, nextAction);

/** The refusal codes of `rh rules promote` (#2887). A `github_*` code can follow a create, so it points to the reconcile. */
const PROMOTE_REFUSALS: Readonly<Record<string, { readonly message: string; readonly next_action: string }>> = Object.freeze({
  candidate_open: { message: 'An open promotion task exists for this candidate.', next_action: 'Open that issue. Run the reconcile if its label or parent link is missing.' },
  candidate_not_found: { message: 'The current ledger has no open action with this candidate id.', next_action: REFRESH_NEXT },
  candidate_not_filed: { message: 'No issue carries the marker of this candidate.', next_action: 'File the promotion task first.' },
  candidate_ambiguous: { message: 'More than one issue carries the marker of this candidate.', next_action: 'Close the duplicate issue, then run the reconcile again.' },
  ledger_changed: { message: 'The committed ledger differs from the one the request names, or the ledger file has local changes.', next_action: REFRESH_NEXT },
  ledger_invalid: { message: 'The ledger is not valid, so no promotion task can be filed.', next_action: 'Correct tasks/lessons.md, then refresh the rules page.' },
  prompt_marker_missing: { message: 'The prompt does not end with the marker of this candidate and route.', next_action: 'Send the prompt of the selected route without a change to its last line.' },
  rules_parent_ambiguous: { message: 'More than one open rules promotion parent exists.', next_action: 'Close the extra parent issue, then send a new request_id.' },
  repository_unavailable: { message: 'The repository has no GitHub identity that the CLI can use.', next_action: 'Add the GitHub remote of the repository, then send a new request_id.' },
});

function promoteRefusal(code: string, issue: number | null): OperatorWriteResponse {
  const entry = PROMOTE_REFUSALS[code] ?? (code.startsWith('github_')
    ? { message: 'A GitHub call of the promotion failed; the issue may exist.', next_action: RECONCILE_NEXT }
    : { message: 'rh rules promote refused the request.', next_action: REFRESH_NEXT });
  return { status: 409, body: { ...operatorWriteError(code, entry.message, entry.next_action), issue } as unknown as JsonValue };
}

/** A child that gives no closed document may have filed the issue: throwing leaves the request `reconcile_required`. */
function promoteOutcome(result: Awaited<ReturnType<RulesProcessRunner>>, candidateId: string): OperatorWriteResponse {
  if (result === null || (result.exit_code !== 0 && result.exit_code !== 1)) throw new Error('rules promote gave no result');
  const value: unknown = JSON.parse(result.stdout);
  const record = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) throw new Error('rules promote output invalid');
    return v as Record<string, unknown>;
  };
  const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  if (result.exit_code === 1) {
    const document = record(value, ['kind', 'protocol', 'error']);
    const error = record(document.error, ['code', 'issue']);
    if (document.kind !== RULES_PROMOTE_KIND || document.protocol !== 1 || typeof error.code !== 'string' || !CODE.test(error.code)
      || (error.issue !== null && !positive(error.issue))) throw new Error('rules promote output invalid');
    return promoteRefusal(error.code, error.issue as number | null);
  }
  const document = record(value, ['kind', 'protocol', 'candidate_id', 'parent', 'issue', 'url', 'prompt_sha256', 'steps']);
  const steps = record(document.steps, ['issue', 'label', 'sub_issue']);
  if (document.kind !== RULES_PROMOTE_KIND || document.protocol !== 1 || document.candidate_id !== candidateId
    || !positive(document.parent) || !positive(document.issue) || typeof document.url !== 'string' || !ISSUE_URL.test(document.url)
    || typeof document.prompt_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(document.prompt_sha256)
    || !['created', 'found'].includes(steps.issue as string) || !['added', 'present'].includes(steps.label as string)
    || !['linked', 'present'].includes(steps.sub_issue as string)) throw new Error('rules promote output invalid');
  return { status: 200, body: document as JsonValue };
}

export interface RulesPromoteRouteOptions {
  readonly admit: BoardCliAdmission;
  /** The child environment. */
  readonly env: NodeJS.ProcessEnv;
  /** The env of the write run, so the prompt file lives in the state directory that the run uses. */
  readonly audit_env?: NodeJS.ProcessEnv;
  readonly read_herdr: () => 'ready' | 'unavailable';
  /** Production runs the CLI; only tests inject another runner. */
  readonly run_process?: RulesProcessRunner;
}

/**
 * The prompt file of one candidate. The target lock on the candidate
 * serializes every write that uses it, so a file that exists outside a run is
 * a leftover of a run that crashed.
 */
function promptFile(auditEnv: NodeJS.ProcessEnv | undefined, candidateId: string): string {
  return join(prepareOperatorStateDir(auditEnv), 'rules-prompts', `${candidateId}.md`);
}

function context(options: RulesPromoteRouteOptions) {
  const env = withoutRepositorySelectingGitEnv({ ...options.env, NO_COLOR: '1' });
  const run = options.run_process ?? runRulesProcess;
  const checkHerdr = () => {
    if (options.read_herdr() !== 'ready') {
      throw refusal(409, 'herdr_unavailable', 'The Herdr runtime is unavailable, so no promotion task starts.', 'Start the hc core and the runtime status source, then send a new request_id.');
    }
  };
  const repositoryPath = (repositoryId: string): string => {
    let repos;
    try { repos = readRepoHarnessRegistryStrictSnapshot({ env }).repos; } catch {
      throw refusal(503, 'registry_unavailable', 'The repository registry is unreadable.', 'Run `rh fleet prune` to show the registry error.');
    }
    const repo = repos.find(entry => entry.id === repositoryId);
    if (!repo) throw refusal(404, 'repository_not_found', 'No registered repository has this id.', 'Choose a repository from the repository list.');
    return repo.path;
  };
  const admitted = async (work: (signal: AbortSignal) => Promise<OperatorWriteResponse>): Promise<OperatorWriteResponse> => {
    const result = options.admit(work);
    if (result === null) throw refusal(503, 'rules_busy', 'Too many console commands are running.', 'Send a new request_id in a few seconds.');
    return result;
  };
  const promote = (path: string, args: readonly string[], signal: AbortSignal) =>
    run([RULES_CLI_ENTRY, 'rules', 'promote', ...args, '--target', path, '--json'], { cwd: path, env, timeout_ms: RULES_PROMOTE_TIMEOUT_MS, signal });
  return { checkHerdr, repositoryPath, admitted, promote };
}

const decodeCandidate = (value: unknown): string => {
  if (typeof value !== 'string' || !CANDIDATE.test(value)) throw new Error('candidate_id');
  return value;
};

export function rulesPromoteWriteRoute(options: RulesPromoteRouteOptions): OperatorWriteRoute {
  const { checkHerdr, repositoryPath, admitted, promote } = context(options);
  return {
    id: 'rules_promote',
    path: OPERATOR_RULES_PROMOTIONS_ROUTE,
    decode(fields, params) {
      if (Object.keys(fields).sort().join() !== 'candidate_id,ledger_blob,prompt,route') throw new Error('fields');
      const repositoryId = params[0]!;
      const candidateId = decodeCandidate(fields.candidate_id);
      if (typeof fields.route !== 'string' || !ROUTING_CLASSES.includes(fields.route as RoutingClass)) throw new Error('route');
      if (typeof fields.ledger_blob !== 'string' || !BLOB.test(fields.ledger_blob)) throw new Error('ledger_blob');
      if (!isRulesPromptText(fields.prompt)) throw new Error('prompt');
      const route = fields.route as RoutingClass, ledgerBlob = fields.ledger_blob, prompt = fields.prompt;
      return {
        operation: 'rules_promote',
        target: `rules_candidate:${candidateId}`,
        // Only the request body binds: the candidate id and the ledger blob fix the theme and the action, and a
        // binding read from the rules cache would turn the replay of a recorded result into request_mismatch.
        input: { repository_id: repositoryId, candidate_id: candidateId, ledger_blob: ledgerBlob, route, prompt_sha256: sha256Hex(prompt) },
        execute: async () => {
          checkHerdr();
          const path = repositoryPath(repositoryId);
          return admitted(async (signal) => {
            let file: string;
            try {
              file = promptFile(options.audit_env, candidateId);
              mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
              writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 });
            } catch {
              throw refusal(503, 'prompt_write_failed', 'The prompt file could not be written. Nothing was changed.', 'Check the operator state directory, then send a new request_id.');
            }
            const result = await promote(path, ['--candidate', candidateId, '--route', route, '--ledger-blob', ledgerBlob, '--prompt-file', file], signal);
            // A delete that fails leaves the request `reconcile_required`; the reconcile removes the file.
            rmSync(file, { force: true });
            return promoteOutcome(result, candidateId);
          });
        },
      };
    },
  };
}

export function rulesReconcileWriteRoute(options: RulesPromoteRouteOptions): OperatorWriteRoute {
  const { checkHerdr, repositoryPath, admitted, promote } = context(options);
  return {
    id: 'rules_reconcile',
    path: OPERATOR_RULES_RECONCILE_ROUTE,
    decode(fields, params) {
      if (Object.keys(fields).join() !== 'candidate_id') throw new Error('fields');
      const repositoryId = params[0]!;
      const candidateId = decodeCandidate(fields.candidate_id);
      return {
        operation: 'rules_reconcile',
        target: `rules_candidate:${candidateId}`,
        input: { repository_id: repositoryId, candidate_id: candidateId },
        execute: async () => {
          checkHerdr();
          const path = repositoryPath(repositoryId);
          return admitted(async (signal) => {
            try {
              rmSync(promptFile(options.audit_env, candidateId), { force: true });
            } catch {
              throw refusal(409, 'prompt_cleanup_failed', 'The prompt file of an earlier promotion could not be removed. Nothing was changed.', 'Check the operator state directory, then send a new request_id.');
            }
            return promoteOutcome(await promote(path, ['--candidate', candidateId, '--reconcile'], signal), candidateId);
          });
        },
      };
    },
  };
}
