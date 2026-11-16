import { Command } from 'commander';
import { BotRegistryError, findBot, readBotRegistry, registerBot } from '../../effects/bot-registry';

interface BotsRegisterOptions {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly slackBotId?: string;
  readonly herdrAgent?: string;
  readonly replace?: boolean;
  readonly json?: boolean;
}

interface BotsReadOptions {
  readonly json?: boolean;
}

const BOTS_LIST_KIND = 'repo-harness.bots';
const BOTS_LIST_PROTOCOL = 1;

function reportError(error: unknown, fallbackCode: string, json: boolean | undefined, exitCode: (code: string) => number): void {
  const code = error instanceof BotRegistryError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  console.error(json ? JSON.stringify({ ok: false, error: code, message }) : `rh bots: ${code}: ${message}`);
  process.exitCode = exitCode(code);
}

export function buildBotsCommand(): Command {
  const bots = new Command('bots').description('Register Bots for attribution; registration grants no access');
  bots
    .command('register')
    .description('Write ~/.repo-harness/bots/<bot-id>.json')
    .requiredOption('--id <bot-id>', 'Bot id: [a-z][a-z0-9-]{0,62}')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--host <host>', 'Bot host, for example Hermes, Grok or Dot')
    .option('--slack-bot-id <slack-bot-id>', 'Slack bot id')
    .option('--herdr-agent <name>', 'Herdr agent name of the Bot pane')
    .option('--replace', 'Overwrite an existing record with the same id')
    .option('--json', 'Output JSON')
    .action((options: BotsRegisterOptions) => {
      try {
        const bot = registerBot({
          bot_id: options.id,
          name: options.name,
          host: options.host,
          slack_bot_id: options.slackBotId ?? null,
          herdr_agent: options.herdrAgent ?? null,
          replace: options.replace === true,
        });
        console.log(options.json ? JSON.stringify({ ok: true, bot }, null, 2) : `[repo-harness bots] registered ${bot.bot_id} (${bot.host})`);
      } catch (error) {
        reportError(error, 'bot_register_failed', options.json, () => 2);
      }
    });
  bots
    .command('list')
    .description('List the registered Bots, sorted by id')
    .option('--json', 'Output JSON')
    .action((options: BotsReadOptions) => {
      try {
        // The registry reads in file-name order, where `a-b.json` precedes `a.json`.
        const records = [...readBotRegistry()].sort((left, right) => (left.bot_id < right.bot_id ? -1 : 1));
        if (options.json) console.log(JSON.stringify({ kind: BOTS_LIST_KIND, protocol: BOTS_LIST_PROTOCOL, bots: records }, null, 2));
        else for (const bot of records) console.log(`${bot.bot_id}  ${bot.name}  ${bot.host}`);
      } catch (error) {
        reportError(error, 'bot_registry_invalid', options.json, () => 1);
      }
    });
  bots
    .command('show')
    .description('Show one registered Bot')
    .argument('<bot-id>', 'Bot id')
    .option('--json', 'Output JSON')
    .action((botId: string, options: BotsReadOptions) => {
      try {
        const bot = findBot(botId);
        console.log(options.json
          ? JSON.stringify(bot, null, 2)
          : Object.entries(bot).map(([field, value]) => `${field}: ${value ?? '-'}`).join('\n'));
      } catch (error) {
        reportError(error, 'bot_registry_invalid', options.json, code => (code === 'bot_id_invalid' ? 2 : 1));
      }
    });
  return bots;
}
