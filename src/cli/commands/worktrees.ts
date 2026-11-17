import { Command } from 'commander';
import { runInternalHelper } from '../../effects/runtime/helper-runner';
import type { WorktreeCleanOptions, WorktreePathOptions } from './worktrees-actions';

const actions = () => import('./worktrees-actions');

/** Each lifecycle subcommand runs one internal helper with these leading arguments. */
const LIFECYCLE_COMMANDS = [
  { name: 'start', helper: 'contract-worktree', leading: ['start'], description: 'Start an isolated worktree for an open issue' },
  { name: 'cleanup', helper: 'contract-worktree', leading: ['cleanup'], description: 'Remove a merged contract worktree, its branch and its metadata' },
  { name: 'notify-merged', helper: 'contract-worktree', leading: ['notify-merged'], description: 'Tell the owner terminal that its worktree branch merged' },
  { name: 'sweep', helper: 'contract-worktree', leading: ['sweep'], description: 'Remove the merged, clean and unowned managed worktrees' },
  { name: 'status', helper: 'contract-worktree', leading: ['status'], description: 'Print whether this checkout is a linked worktree, with its branch and root' },
  { name: 'runtime', helper: 'contract-worktree-runtime', leading: [], description: 'Bind task worktrees to Herdr and close recorded runtime before checkout cleanup' },
  { name: 'ship', helper: 'ship-worktrees', leading: [], description: 'Commit, push, and open draft PRs for finished contract worktrees' },
] as const;

export function buildWorktreesCommand(): Command {
  const worktrees = new Command('worktrees').description('Start, inspect, ship and clean up worktrees');
  for (const entry of LIFECYCLE_COMMANDS) {
    worktrees
      .command(entry.name)
      .description(entry.description)
      .helpOption(false)
      .allowUnknownOption(true)
      .argument('[args...]', 'Arguments passed to the helper unchanged')
      .action((args: string[]) => {
        const result = runInternalHelper({ helper: entry.helper, args: [...entry.leading, ...args] });
        if (result.stderr && result.reason !== 'ok') console.error(result.stderr);
        process.exit(result.exitCode);
      });
  }
  worktrees
    .command('list')
    .description('Collect every worktree with its judgment, reasons and the selection digest')
    .option('--json', 'Output JSON')
    .action(async (options: { readonly json?: boolean }) => (await actions()).list(options));
  worktrees
    .command('clean')
    .description('Remove green worktrees by stable id; a non-green or changed selection removes nothing')
    .requiredOption('--ids <ids>', 'Comma-separated worktree ids from `worktrees list`')
    .requiredOption('--expected-digest <digest>', 'Selection digest from `worktrees list`')
    .option('--request-id <uuid>', 'Lower-case UUID; reuse it to replay the recorded result')
    .option('--json', 'Output JSON')
    .action(async (options: WorktreeCleanOptions) => (await actions()).clean(options));
  worktrees
    .command('path')
    .description('Print the absolute path of one registered worktree as JSON, for the desktop shell')
    // `[id]`: a flag without a value reaches the action, which refuses it with the JSON error instead of Commander's text.
    .option('--repository [id]', 'Repository id from `worktrees list --json`')
    .option('--worktree [id]', 'Worktree id from `worktrees list --json`')
    .action(async (options: WorktreePathOptions) => (await actions()).path(options));
  return worktrees;
}
