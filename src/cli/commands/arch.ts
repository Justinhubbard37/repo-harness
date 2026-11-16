import { Command } from 'commander';

/** `rh arch <command> [args...]` runs one command of the pinned archctx. */
export function buildArchCommand(): Command {
  return new Command('arch')
    .description('Run a command of the pinned package-local archctx')
    .argument('[command]', 'archctx command')
    .argument('[args...]', 'arguments passed to archctx unchanged')
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => (await import('./arch-actions')).runArch(process.argv.slice(process.argv.indexOf('arch') + 1)));
}
