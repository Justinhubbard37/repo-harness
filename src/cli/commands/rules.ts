import { Command } from 'commander';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  TEST_BUDGET_IMPLEMENTATION_VERSION,
  TEST_BUDGET_RESULT_SCHEMA,
  describeTestBudget,
  evaluateTestBudget,
  githubNoticeCommand,
  parseTestBudgetException,
  readTestBudgetConfig,
  renderTestBudgetSummary,
  testBudgetError,
  testBudgetExceptionDigest,
  testBudgetPolicyDigest,
  type TestBudgetBound,
  type TestBudgetDiffEntry,
  type TestBudgetException,
  type TestBudgetResult,
} from '../../core/ci/test-budget';
import {
  RULES_LEDGER_PATH,
  RULES_STATUS_KIND,
  RULES_STATUS_PROTOCOL,
  decodeTriageReport,
  describeRuleStatus,
  ruleStatus,
  type RuleLedgerReadV1,
  type RuleStatusV1,
} from '../../core/ci/rule-candidates';
import { RULES } from '../../core/ci/rules';
import {
  DEFAULT_PROMPT_ROUTE, RULES_PROMOTE_KIND, RulesPromoteError,
  promotionCandidate, renderPromotionPrompt,
} from '../../core/ci/rule-prompt';
import { promoteRules, promotionRoute, reconcileRules, type RulesPromoteResult } from '../../effects/rules/promote';
import type { GithubCommandRunner } from '../../effects/github/issues';
import { POLICY_PATH, decodeWorkflowPolicy } from '../../core/workflow/policy-schema';
import { githubRemoteRepository } from '../../core/board/source';
import { sha256Hex } from '../../core/evidence/sha256';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { gitExecFileSync, gitSpawnSync } from '../../effects/git/runner';
import { runHelper } from '../../effects/runtime/helper-runner';

interface TestBudgetCheckInput {
  /** Any directory inside the repository; the check runs at its top level. */
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  readonly bodyFile: string;
}

class CheckError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function git(repoRoot: string, args: readonly string[], code: string): string {
  try {
    return gitExecFileSync(['-C', repoRoot, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new CheckError(code, `git ${args[0]} failed: ${(error as Error).message.split('\n')[0]}`);
  }
}

function commit(repoRoot: string, rev: string, code: string): string {
  return git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], code).trim();
}

/** The policy text at the base commit, or null when the base has no policy file. */
function policyTextAt(repoRoot: string, base: string): string | null {
  const listed = git(repoRoot, ['ls-tree', '-z', base, '--', POLICY_PATH], 'policy_unreadable');
  if (listed === '') return null;
  return git(repoRoot, ['cat-file', 'blob', `${base}:${POLICY_PATH}`], 'policy_unreadable');
}

// `--no-relative` keeps paths root-relative under a `diff.relative` setting.
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-relative', '-M'] as const;

/** `git diff --name-status` and `--numstat` with the same rename detection, joined by the new path. */
function diffEntries(repoRoot: string, start: string, head: string): TestBudgetDiffEntry[] {
  const names = git(repoRoot, ['diff', ...DIFF_ARGS, '--name-status', '-z', start, head, '--'], 'diff_unavailable').split('\0');
  const stats = git(repoRoot, ['diff', ...DIFF_ARGS, '--numstat', '-z', start, head, '--'], 'diff_unavailable').split('\0');
  const added = new Map<string, number | null>();
  for (let index = 0; index < stats.length - 1; index += 1) {
    // `added<TAB>deleted<TAB>path`: a path keeps any tab it holds. A rename prints an
    // empty path, then the old and the new path as their own fields.
    const record = stats[index]!;
    const first = record.indexOf('\t');
    const plus = record.slice(0, first);
    const path = record.slice(record.indexOf('\t', first + 1) + 1);
    const target = path === '' ? stats[(index += 2)]! : path;
    added.set(target, plus === '-' ? null : Number(plus));
  }
  const entries: TestBudgetDiffEntry[] = [];
  for (let index = 0; index < names.length - 1; index += 1) {
    const status = names[index]!;
    const kind = status[0];
    const previous = kind === 'R' ? names[++index]! : null;
    const path = names[++index]!;
    const lines = added.get(path);
    if (lines === undefined) throw new CheckError('diff_unavailable', `git diff --numstat has no line count for ${path}`);
    const mapped = kind === 'A' ? 'added' : kind === 'M' || kind === 'T' ? 'modified' : kind === 'D' ? 'deleted' : kind === 'R' ? 'renamed' : null;
    if (mapped === null) throw new CheckError('diff_unavailable', `git diff reported the unexpected status ${status} for ${path}`);
    entries.push({ status: mapped, path, previous_path: previous, added_lines: lines });
  }
  return entries;
}

/**
 * Run `TestBudget` for one PR. The configuration comes from the base commit, so
 * a PR cannot change the parameters that judge it; the diff starts at the
 * merge-base of base and head.
 */
export function runTestBudgetCheck(input: TestBudgetCheckInput): { result: TestBudgetResult; lines: string[] } {
  const bound: { -readonly [Key in keyof TestBudgetBound]: TestBudgetBound[Key] | null } = {
    head_sha: null, diff_start: null, policy_digest: null,
    implementation_version: TEST_BUDGET_IMPLEMENTATION_VERSION, exception_digest: null,
  };
  let exception: TestBudgetException = { status: 'absent' };
  try {
    const repoRoot = git(input.cwd, ['rev-parse', '--show-toplevel'], 'repository_unavailable').trim();
    bound.head_sha = commit(repoRoot, input.head, 'head_unavailable');
    const base = commit(repoRoot, input.base, 'base_unavailable');
    let body: string;
    try {
      body = readFileSync(input.bodyFile, 'utf8');
    } catch (error) {
      throw new CheckError('body_unreadable', `cannot read the PR body file: ${(error as Error).message}`);
    }
    exception = parseTestBudgetException(body);
    bound.exception_digest = testBudgetExceptionDigest(exception);
    let decoded;
    try {
      decoded = decodeWorkflowPolicy(policyTextAt(repoRoot, base));
    } catch (error) {
      if (error instanceof CheckError) throw error;
      throw new CheckError('policy_invalid', (error as Error).message);
    }
    const config = readTestBudgetConfig(decoded);
    if (config.status === 'invalid') throw new CheckError('policy_invalid', `${POLICY_PATH} at ${base}: ${config.message}`);
    bound.policy_digest = testBudgetPolicyDigest(config);
    if (git(repoRoot, ['rev-parse', '--is-shallow-repository'], 'diff_unavailable').trim() !== 'false') {
      throw new CheckError('diff_unavailable', 'the clone is shallow; the merge-base needs the full history');
    }
    bound.diff_start = git(repoRoot, ['merge-base', base, bound.head_sha], 'merge_base_unavailable').trim();
    const result = evaluateTestBudget({
      head_sha: bound.head_sha,
      diff_start: bound.diff_start,
      config,
      entries: config.status === 'present' && config.config.enabled ? diffEntries(repoRoot, bound.diff_start, bound.head_sha) : [],
      exception,
    });
    return { result, lines: describeTestBudget(result, exception) };
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    const result = testBudgetError(bound, error.code, error.message);
    return { result, lines: describeTestBudget(result, exception) };
  }
}

/** A refusal of `rh rules status`: the code is stable, the message names the failed read. */
export class RulesStatusError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RulesStatusError';
  }
}

const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REMOTE_URL_KEY = /^remote\.(.+)\.url$/u;
const REMOTE_URL_QUERY = ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.url$'] as const;

/** A git read of the target checkout. A failure is a named refusal, never an empty value. */
function statusGit(target: string, args: readonly string[], code: string): string {
  try {
    return gitExecFileSync(['-C', target, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new RulesStatusError(code, `git ${args[0]} failed: ${(error as Error).message.split('\n')[0]}`);
  }
}

/**
 * The local remote URLs as `name -> url` pairs. Exit 1 with no output means that
 * no remote URL is configured, which is not a failure.
 */
function remoteUrls(target: string): [string, string][] {
  const result = gitSpawnSync(['-C', target, ...REMOTE_URL_QUERY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 1 && result.stdout === '') return [];
  if (result.error || result.status !== 0) {
    throw new RulesStatusError('repository_unavailable', `git config failed: ${(result.error?.message ?? result.stderr).split('\n')[0]}`);
  }
  // `--null` gives `key LF value NUL`, so a value that holds a newline cannot forge a second key.
  return result.stdout.split('\0').flatMap((record): [string, string][] => {
    const split = record.indexOf('\n');
    const name = split < 0 ? null : REMOTE_URL_KEY.exec(record.slice(0, split))?.[1];
    return name === undefined || name === null ? [] : [[name, record.slice(split + 1)]];
  });
}

/**
 * The repository identity of the status document. `candidate_id` must be the same
 * on every host that holds one repository, so this is not the registry id of
 * `repoHarnessRepoIdFor`, which hashes the absolute checkout path.
 *
 * - `github:<owner>/<name>` from the remote URLs. Only the parsed owner/name
 *   leaves this function: a URL is git config text and can hold a credential (I1).
 *   The `origin` remote decides; with no `origin`, one distinct GitHub repository
 *   decides. Two different GitHub repositories with no `origin` give no answer,
 *   because the command cannot tell which one the checkout is.
 * - `local:<16 hex>` of the git common directory when no GitHub remote answers.
 *   Two hosts of such repository get different ids, so their candidates do not
 *   meet; the id is still stable across two runs on one host.
 */
export function repositoryIdentity(target: string): string {
  const parsed = new Map<string, string>();
  for (const [name, url] of remoteUrls(target)) {
    const github = githubRemoteRepository(url);
    if (github !== null) parsed.set(name, github);
  }
  const distinct = new Set(parsed.values());
  const github = parsed.get('origin') ?? (distinct.size === 1 ? [...distinct][0] : null);
  if (github) return `github:${github}`;
  const local = `local:${sha256Hex(resolveGitCommonDirectory(target)).slice(0, 16)}`;
  if (!REPOSITORY_ID.test(local)) throw new RulesStatusError('repository_unavailable', 'the repository identity is not a usable id');
  return local;
}

/**
 * The ledger read of one checkout: the head commit, the committed blob of the
 * ledger, and whether the working-tree file differs from that blob. All three
 * come from git; no ledger text is read here.
 */
function readLedger(target: string): RuleLedgerReadV1 {
  if (!existsSync(resolve(target, RULES_LEDGER_PATH))) {
    throw new RulesStatusError('ledger_missing', `working-tree ${RULES_LEDGER_PATH} is missing`);
  }
  const head = statusGit(target, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], 'ledger_unreadable').trim();
  if (!COMMIT_SHA.test(head)) throw new RulesStatusError('ledger_unreadable', 'git rev-parse HEAD gave no commit id');
  const blob = statusGit(target, ['rev-parse', '--verify', '--end-of-options', `HEAD:${RULES_LEDGER_PATH}`], 'ledger_missing').trim();
  if (!COMMIT_SHA.test(blob)) throw new RulesStatusError('ledger_unreadable', `git rev-parse HEAD:${RULES_LEDGER_PATH} gave no blob id`);
  // `status --porcelain` covers a modified, staged, deleted or untracked ledger file.
  const status = statusGit(target, ['status', '--porcelain', '--untracked-files=all', '--', RULES_LEDGER_PATH], 'ledger_unreadable');
  return { head, blob, dirty: status.trim() !== '' };
}

/**
 * Run the `maintenance-triage` helper in the target and build the status
 * document. The helper is the one parser of the ledger and the only source of
 * ledger values; git is the only source of the head, the blob and the dirty flag.
 */
export function runRulesStatus(input: { target: string }): RuleStatusV1 {
  const target = statusGit(resolve(input.target), ['rev-parse', '--show-toplevel'], 'repository_unavailable').trim();
  const ledger = readLedger(target);
  const run = runHelper({ helper: 'maintenance-triage', args: ['--json'], cwd: target, stdio: 'pipe' });
  // Exit 1 with a valid document is a ledger with an error row, not a failed read.
  if (run.reason !== 'ok' || (run.exitCode !== 0 && run.exitCode !== 1)) {
    throw new RulesStatusError('triage_failed', (run.stderr ?? '').trim() || `maintenance-triage exited with ${run.exitCode}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout ?? '');
  } catch (error) {
    throw new RulesStatusError('triage_invalid', `maintenance-triage --json gave no JSON: ${(error as Error).message}`);
  }
  let report;
  try {
    report = decodeTriageReport(parsed);
  } catch (error) {
    throw new RulesStatusError('triage_invalid', (error as Error).message);
  }
  return ruleStatus(report, repositoryIdentity(target), ledger);
}

interface RulesCheckOptions {
  base: string;
  head: string;
  bodyFile: string;
  githubAnnotation?: boolean;
  githubSummary?: string;
}

interface RulesStatusOptions {
  target?: string;
  json?: boolean;
}

export interface RulesPromoteOptions {
  candidate: string;
  target?: string;
  route?: string;
  ledgerBlob?: string;
  promptFile?: string;
  printPrompt?: boolean;
  reconcile?: boolean;
  json?: boolean;
}

/** Print is read-only; reconcile depends only on the repository and the filed marker. */
export function runRulesPromote(options: RulesPromoteOptions, runner?: GithubCommandRunner): RulesPromoteResult | string {
  if (!/^[a-f0-9]{64}$/u.test(options.candidate)) throw new RulesPromoteError('candidate_not_found');
  if ((options.reconcile && (options.printPrompt || options.route || options.ledgerBlob || options.promptFile))
    || (options.printPrompt && (options.promptFile || options.ledgerBlob))
    || (!options.reconcile && !options.printPrompt && (!options.route || !options.ledgerBlob))) {
    throw new RulesPromoteError('options_invalid');
  }
  const target = statusGit(resolve(options.target ?? process.cwd()), ['rev-parse', '--show-toplevel'], 'repository_unavailable').trim();
  if (options.reconcile) return reconcileRules({ repository_id: repositoryIdentity(target), candidate_id: options.candidate }, runner);
  const status = runRulesStatus({ target });
  const route = promotionRoute(options.route ?? DEFAULT_PROMPT_ROUTE);
  const candidate = promotionCandidate(status, options.candidate, options.ledgerBlob);
  if (options.printPrompt) return renderPromotionPrompt(candidate, route);
  let prompt: string | undefined;
  if (options.promptFile !== undefined) {
    try { prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(options.promptFile)); }
    catch { throw new RulesPromoteError('prompt_unreadable'); }
  }
  return promoteRules({ status, candidate_id: options.candidate, route, ledger_blob: options.ledgerBlob!, prompt }, runner);
}

/** The refusal document of `rh rules status`: one error code, no partial status. */
function statusRefusal(code: string, message: string): void {
  process.stderr.write(`rh rules status: ${code}: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ kind: RULES_STATUS_KIND, protocol: RULES_STATUS_PROTOCOL, error: { code } })}\n`);
  process.exitCode = 1;
}

export function buildRulesCommand(): Command {
  const rules = new Command('rules').description('Run a repository rule check');
  rules
    .command('check')
    .description('Check one rule and print its result document; exit 1 on a violation, 2 on an error')
    .argument('<rule>', `rule id (${RULES.TestBudget.id})`)
    .requiredOption('--base <rev>', 'base commit: the policy source and one side of the merge-base')
    .requiredOption('--head <rev>', 'PR head commit')
    .requiredOption('--body-file <path>', 'file with the PR body text')
    .option('--github-annotation', `also print the result as a GitHub Actions notice titled ${TEST_BUDGET_RESULT_SCHEMA}`)
    .option('--github-summary <path>', 'also append the human summary as Markdown to this file ($GITHUB_STEP_SUMMARY in a job)')
    .action((rule: string, options: RulesCheckOptions) => {
      if (rule !== RULES.TestBudget.id) {
        process.stderr.write(`unknown rule id: ${rule}\n`);
        process.exitCode = 2;
        return;
      }
      const { result, lines } = runTestBudgetCheck({ cwd: process.cwd(), base: options.base, head: options.head, bodyFile: options.bodyFile });
      const document = JSON.stringify(result);
      process.stdout.write(`${document}\n`);
      if (options.githubAnnotation) process.stdout.write(`${githubNoticeCommand(TEST_BUDGET_RESULT_SCHEMA, document)}\n`);
      if (options.githubSummary) appendFileSync(options.githubSummary, renderTestBudgetSummary(result));
      process.stderr.write(`${lines.join('\n')}\n`);
      process.exitCode = result.state === 'violation' ? 1 : result.state === 'error' ? 2 : 0;
    });
  rules
    .command('status')
    .description(`Read ${RULES_LEDGER_PATH} and print the ledger state, every theme and the open promotion actions; exit 1 on an invalid ledger`)
    .option('--target <path>', 'checkout to read (default: the working directory)')
    .option('--json', 'print the status document instead of the text lines')
    .action((options: RulesStatusOptions) => {
      const target = options.target ?? process.cwd();
      let status: RuleStatusV1;
      try {
        status = runRulesStatus({ target });
      } catch (error) {
        if (!(error instanceof RulesStatusError)) throw error;
        statusRefusal(error.code, error.message);
        return;
      }
      if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
      else process.stdout.write(`${describeRuleStatus(status).join('\n')}\n`);
      process.exitCode = status.ledger.valid ? 0 : 1;
    });
  rules
    .command('promote')
    .description('Print, file or reconcile one rules promotion task; never dispatch a seat')
    .requiredOption('--candidate <id>', 'promotion candidate id from rules status')
    .option('--target <path>', 'target checkout (default: the working directory)')
    .option('--print-prompt', 'print the prompt without any GitHub call')
    .option('--route <class>', 'routing class (print-prompt default: important_fast)')
    .option('--ledger-blob <sha>', 'expected committed ledger blob')
    .option('--prompt-file <path>', 'UTF-8 prompt to file byte for byte')
    .option('--reconcile', 'complete the label and parent link of a filed task')
    .option('--json', 'print the result document')
    .action((options: RulesPromoteOptions) => {
      try {
        const result = runRulesPromote(options);
        process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`);
        process.exitCode = 0;
      } catch (error) {
        if (!(error instanceof RulesPromoteError) && !(error instanceof RulesStatusError)) throw error;
        const code = error instanceof RulesStatusError && error.code !== 'repository_unavailable' ? 'ledger_invalid' : error.code;
        process.stdout.write(`${JSON.stringify({ kind: RULES_PROMOTE_KIND, protocol: 1,
          error: { code, issue: error instanceof RulesPromoteError ? error.issue : null } })}\n`);
        process.exitCode = 1;
      }
    });
  return rules;
}
