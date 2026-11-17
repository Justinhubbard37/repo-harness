import { Command } from 'commander';

/**
 * `rh arch <command> [args...]` runs one command of the pinned archctx. A
 * registered subcommand takes precedence over that pass-through. The CLI root
 * adds the architecture command groups, so this file imports no other capability.
 */
export function buildArchCommand(): Command {
  const arch = new Command('arch')
    .description('Run the architecture commands, or a command of the pinned package-local archctx')
    .argument('[command]', 'archctx command')
    .argument('[args...]', 'arguments passed to archctx unchanged')
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => (await import('./arch-actions')).runArch(process.argv.slice(process.argv.indexOf('arch') + 1)));
  arch.command('verify')
    .description('Report one verdict over the ArchContext checks of a change')
    .option('--base <ref>', 'The commit or ref the change is measured against')
    .option('--json', 'Output the verdict document instead of one line per check')
    .action(async (options: { base?: string; json?: boolean }) => (await import('./arch-verify')).runArchVerify(options));
  return arch;
}
