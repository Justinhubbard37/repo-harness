import { Command, type Option } from 'commander';
import type { PluginId } from '../../core/skill-surface/plugin-manifest';
import { CLI_VERSION } from './status';

/** The plugin that owns a command. The registration site records it; a command without a record takes its nearest ancestor's. */
const COMMAND_PLUGINS = new WeakMap<Command, PluginId>();

export function recordCommandPlugin(command: Command, id: PluginId): void {
  COMMAND_PLUGINS.set(command, id);
}

export interface ManifestOption {
  readonly flags: string;
  readonly required: boolean;
  readonly description: string;
}

export interface ManifestCommand {
  readonly path: readonly string[];
  readonly description: string;
  readonly plugin: PluginId | 'core';
  readonly passthrough: boolean;
  readonly arguments: readonly string[];
  readonly options: readonly ManifestOption[];
}

/** Commander keeps the unknown-option switch private; this is the only reader. */
export function allowsUnknownOptions(command: Command): boolean {
  return (command as unknown as { _allowUnknownOption: boolean })._allowUnknownOption;
}

/** The implicit help command of one command, or undefined. Commander adds this command to the parse path at run time, so `rh <path> help [<sub>]` prints help and exits 0, while a command with its own action (`rh board help`) is a usage error. Commander keeps the accessor private; this is the only reader. */
export function implicitHelpCommand(command: Command): Command | undefined {
  // SAFETY: Commander 15 defines `_getHelpCommand` on every Command and it returns the implicit help command or null; the public type has no equivalent.
  return (command as unknown as { _getHelpCommand: () => Command | null })._getHelpCommand() ?? undefined;
}

/** The options that bind for the last command of a chain: its own, then each ancestor's. Commander binds an ancestor option wherever it appears. A nearer declaration of the same flag wins. */
export function effectiveOptions(chain: readonly Command[]): Option[] {
  const seen = new Set<string>();
  const options: Option[] = [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    for (const option of chain[index].options) {
      const key = option.long ?? option.short ?? option.flags;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option);
    }
  }
  return options;
}

function pluginOf(chain: readonly Command[]): PluginId | 'core' {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const id = COMMAND_PLUGINS.get(chain[index]);
    if (id !== undefined) return id;
  }
  return 'core';
}

function argumentLabel(argument: Command['registeredArguments'][number]): string {
  const name = `${argument.name()}${argument.variadic ? '...' : ''}`;
  return argument.required ? `<${name}>` : `[${name}]`;
}

/** One walk of the commander tree gives every listing: the JSON manifest, the plain `rh commands` list and, through `implicitHelpCommand()`, the drift gate. A leaf is a registered command without subcommands, so Commander's implicit help command is never a leaf. */
function collectLeaves(root: Command): Array<ManifestCommand & { readonly hidden: boolean }> {
  const entries: Array<ManifestCommand & { readonly hidden: boolean }> = [];
  const help = root.createHelp();
  const walk = (chain: readonly Command[], hidden: boolean): void => {
    const command = chain[chain.length - 1];
    for (const child of command.commands) {
      const childHidden = hidden || !help.visibleCommands(command).includes(child);
      const childChain = [...chain, child];
      if (child.commands.length > 0) {
        walk(childChain, childHidden);
        continue;
      }
      entries.push({
        path: childChain.slice(1).map(node => node.name()),
        description: child.description(),
        plugin: pluginOf(childChain),
        passthrough: allowsUnknownOptions(child),
        arguments: child.registeredArguments.map(argumentLabel),
        options: effectiveOptions(childChain).map(option => ({ flags: option.flags, required: option.mandatory, description: option.description })),
        hidden: childHidden,
      });
    }
  };
  walk([root], false);
  return entries.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')));
}

/** Every leaf command of the tree, hidden ones included, sorted by its path. */
export function collectCommandManifest(root: Command): ManifestCommand[] {
  return collectLeaves(root).map(({ hidden: _hidden, ...entry }) => entry);
}

/** `rh commands` text: the visible leaves of the same walk as the JSON manifest, so the plain list and the JSON name one set of leaves. */
function visiblePaths(root: Command): string[] {
  return collectLeaves(root).filter(entry => !entry.hidden).map(entry => entry.path.join(' '));
}

/** `rh commands`: the command tree as data, derived from the commander tree at run time. */
export function buildCommandsCommand(program: () => Command): Command {
  return new Command('commands')
    .description('List every rh command; --json adds arguments, options and the owning plugin')
    .option('--json', 'Output one JSON document instead of one line per visible command')
    .action((rawOpts: { json?: boolean }) => {
      const root = program();
      if (rawOpts.json === true) {
        console.log(JSON.stringify({ kind: 'repo-harness.commands', protocol: 1, cli_version: CLI_VERSION, commands: collectCommandManifest(root) }, null, 2));
        return;
      }
      for (const path of visiblePaths(root)) console.log(path);
    });
}
