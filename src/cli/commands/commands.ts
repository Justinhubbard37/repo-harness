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

/** Every leaf command of the tree, hidden ones included, sorted by its path. */
export function collectCommandManifest(root: Command): ManifestCommand[] {
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
  return entries.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' '))).map(({ hidden: _hidden, ...entry }) => entry);
}

function visiblePaths(root: Command): string[] {
  const paths: string[] = [];
  const help = root.createHelp();
  const walk = (command: Command, prefix: readonly string[]): void => {
    for (const child of help.visibleCommands(command)) {
      const path = [...prefix, child.name()];
      if (child.commands.length > 0) walk(child, path);
      else paths.push(path.join(' '));
    }
  };
  walk(root, []);
  return paths.sort();
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
