/**
 * The rule registry: one entry per rule with its stable id, its parameters and
 * the repair hint that a failing check prints. The id has the same spelling in
 * `.ai/harness/policy.json` (`rules.<id>`) and in each result. The registry
 * holds no parameter value: the policy is the one authority for the caps.
 */
export interface RuleEntry<Parameter extends string> {
  readonly id: string;
  readonly parameters: Readonly<Record<Parameter, string>>;
  readonly repair: string;
}

export interface TestBudgetParameters {
  readonly ratio_cap: number;
  readonly file_cap: number;
  readonly test_paths: readonly string[];
  readonly product_paths: readonly string[];
}

export const RULES = {
  TestBudget: {
    id: 'TestBudget',
    parameters: {
      ratio_cap: 'the largest number of added test lines for each added product line',
      file_cap: 'the largest number of added test files',
      test_paths: 'repository path prefixes of test files; a test path wins over a product path',
      product_paths: 'repository path prefixes of product files',
    },
    repair: 'Remove added test lines or test files, or add a "## Test budget exception" section to the PR body with the lines '
      + '"Added test lines: <n>", "Added product lines: <n>" and "Added test files: <n>" (the measured numbers) and the reason '
      + 'that no existing test can cover the behavior.',
  },
  LedgerEnforcement: {
    id: 'LedgerEnforcement',
    parameters: {},
    repair: 'Change each named tasks/lessons.md entry as its finding states. The Lessons Retro section of '
      + 'docs/reference-configs/agentic-development-flow.md is the contract for the fields and the Seen count.',
  },
} as const satisfies {
  readonly TestBudget: RuleEntry<keyof TestBudgetParameters>;
  readonly LedgerEnforcement: RuleEntry<never>;
};
