import { Command } from 'commander';
import { appendFileSync, readFileSync } from 'fs';
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
import { RULES } from '../../core/ci/rules';
import { POLICY_PATH, decodeWorkflowPolicy } from '../../core/workflow/policy-schema';
import { gitExecFileSync } from '../../effects/git/runner';

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

interface RulesCheckOptions {
  base: string;
  head: string;
  bodyFile: string;
  githubAnnotation?: boolean;
  githubSummary?: string;
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
  return rules;
}
