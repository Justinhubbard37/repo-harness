import { Command } from 'commander';
import { listHelperIds, listHelpers, runHelper } from '../../effects/runtime/helper-runner';

export const RUN_HELP_MAX_HELPERS = 60;
export const RUN_HELP_MAX_LINES = 85;

export const RUN_HELP_GROUPS = [
  {
    label: 'Planning & execution',
    helpers: [
      'new-spec',
      'cutover-closure',
    ],
  },
  {
    label: 'Acceptance & delivery',
    helpers: [
      'acceptance-receipt',
      'change-assessment',
      'runtime-evidence-receipt',
      'merge-gate',
      'harness-trace-grade',
    ],
  },
  {
    label: 'State',
    helpers: [
      'decision-trail',
      'workflow-contract',
      'inspect-project-state',
    ],
  },
  {
    label: 'Verification & maintenance',
    helpers: [
      'validate-harness-profile-benchmark',
      'summarize-failures',
      'check-deploy-sql-order',
      'check-agent-tooling',
      'check-context-files',
      'check-protected-paths',
      'check-skill-version',
      'maintenance-triage',
      'heartbeat-triage',
      'evidence-gc',
    ],
  },
  {
    label: 'Host',
    helpers: ['install-agent-fleet'],
  },
  {
    label: 'Factor lab',
    helpers: ['factor-lab-new', 'factor-lab-promote', 'factor-lab-reject', 'factor-lab-check'],
  },
] as const;

// Retired helper ids fail with their replacement command. They never run it.
const RETIRED_HELPERS: ReadonlyMap<string, string> = new Map([
  ['run-bounded-verifier-command', 'rh verify plan execute'],
]);

// Internal helper ids (`helpers.internal`) fail with the public command that runs them. They never run.
// `worktree-merge-lib` is a library that the worktree helpers load, so it has no command.
export const INTERNAL_HELPER_COMMANDS: ReadonlyMap<string, string | null> = new Map([
  ['capability-config', 'rh capability register'],
  ['capability-resolver', 'rh capability resolve'],
  ['contract-worktree', 'rh worktrees start|cleanup|notify-merged|sweep|status'],
  ['contract-worktree-runtime', 'rh worktrees runtime'],
  ['select-agent-context-blocks', 'rh capability blocks'],
  ['ship-worktrees', 'rh worktrees ship'],
  ['verification-plan', 'rh verify plan'],
  ['verify-sprint', 'rh verify'],
  ['worktree-merge-lib', null],
]);

function internalHelperMessage(id: string): string {
  const command = INTERNAL_HELPER_COMMANDS.get(id);
  if (command === undefined) throw new Error(`rh run: internal helper "${id}" has no entry in INTERNAL_HELPER_COMMANDS`);
  return command === null
    ? `rh run: helper "${id}" is internal. It has no public command.`
    : `rh run: helper "${id}" is internal. Use \`${command}\`.`;
}

function groupedHelperLines(helpers: ReturnType<typeof listHelpers>): string[] {
  const byId = new Map(helpers.map((helper) => [helper.id, helper]));
  const groupedIds = RUN_HELP_GROUPS.flatMap((group) => group.helpers);
  const groupedIdSet = new Set<string>(groupedIds);
  if (groupedIdSet.size !== groupedIds.length) {
    throw new Error('run help groups contain a duplicate helper id');
  }
  const missing = helpers.map((helper) => helper.id).filter((id) => !groupedIdSet.has(id));
  const unknown = groupedIds.filter((id) => !byId.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`run help groups do not match helper authority (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`);
  }

  const width = Math.max(...helpers.map((helper) => helper.id.length));
  return RUN_HELP_GROUPS.flatMap((group, index) => [
    ...(index === 0 ? [] : ['']),
    `${group.label}:`,
    ...group.helpers.map((id) => {
      const helper = byId.get(id)!;
      return `  ${helper.id.padEnd(width)}  ${helper.description}`;
    }),
  ]);
}

function renderHelpersSection(): string {
  let helpers: ReturnType<typeof listHelpers>;
  try {
    helpers = listHelpers();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ['', 'Helpers:', `  (unable to list helpers: ${message})`].join('\n');
  }

  if (helpers.length === 0) return '';

  return ['', 'Helpers:', ...groupedHelperLines(helpers)].join('\n');
}

export function buildRunCommand(): Command {
  const run = new Command('run')
    .description('Run a bundled repo-harness workflow helper')
    .allowUnknownOption(true);

  run
    .argument('<helper>', 'Helper id, for example new-spec')
    .argument('[args...]', 'Arguments passed to the helper')
    .action((helper: string, args: string[]) => {
      const replacement = RETIRED_HELPERS.get(helper);
      if (replacement) {
        console.error(`rh run: helper "${helper}" is retired. Use \`${replacement}\`. Run \`rh init\` to rewrite generated package scripts.`);
        process.exit(2);
      }
      const result = runHelper({ helper, args });
      if (result.reason === 'internal-helper') {
        console.error(internalHelperMessage(result.helper));
        process.exit(2);
      }
      if (result.stderr && result.reason !== 'ok') {
        console.error(result.stderr);
        const helpers = listHelperIds();
        if (helpers.length > 0) console.error(`known helpers: ${helpers.join(', ')}`);
      }
      process.exit(result.exitCode);
    });

  run.addHelpText('after', renderHelpersSection);

  return run;
}
