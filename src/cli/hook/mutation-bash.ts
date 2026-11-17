/** The PreToolUse bash route of Claude and Pi: the safety hook's decision for one Bash command. No state or process reads. */
import { isAbsolute } from 'path';
import { payloadString } from './hook-input';
import { runMutationDenial, type MutationGuardInput, type MutationGuardResult } from './mutation-guard';
import { bashSafetyDenial } from './safety-hook';

export function runBashMutationGuard(opts: MutationGuardInput): MutationGuardResult {
  const command = payloadString(opts.payload, 'tool_input.command');
  const cwd = payloadString(opts.payload, 'cwd');
  // Without an absolute host cwd, a relative target is not known.
  const denial = bashSafetyDenial(command, isAbsolute(cwd) ? cwd : null, { repoRoot: opts.repoRoot, env: opts.env, host: opts.identity.host });
  return denial ? runMutationDenial(opts, denial) : { exitCode: 0, stdout: '', stderr: '' };
}
