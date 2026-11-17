import { Command } from 'commander';
import { runInternalHelper } from '../../effects/runtime/helper-runner';

function runVerification(helper: string, args: string[]): void {
  const result = runInternalHelper({ helper, args });
  if (result.stderr && result.reason !== 'ok') console.error(result.stderr);
  process.exit(result.exitCode);
}

export function buildVerifyCommand(): Command {
  const verify = new Command('verify')
    .description('Run selected checks or work with the Verification Plan')
    .helpOption(false)
    .allowUnknownOption(true)
    .argument('[args...]', 'Arguments passed to the verifier unchanged')
    .action((args: string[]) => runVerification('verify-sprint', args));

  verify.command('plan')
    .description('Validate, evaluate or execute the Verification Plan')
    .helpOption(false)
    .allowUnknownOption(true)
    .argument('<action>', 'validate, evaluate, execute')
    .argument('[args...]', 'Arguments passed to the plan helper unchanged')
    .action((action: string, args: string[]) => {
      if (!['validate', 'evaluate', 'execute'].includes(action)) {
        console.error(`rh verify plan: unknown action "${action}" (expected: validate, evaluate, execute)`);
        process.exit(2);
      }
      runVerification('verification-plan', [action, ...args]);
    });

  return verify;
}
