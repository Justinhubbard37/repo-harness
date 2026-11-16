import { archctxRefusal } from '../../core/architecture/projection';
import { runArchctxPassThrough } from '../../effects/architecture/archctx-provider';

/** The disposition check runs before any process starts; an archctx failure exits with its own code. */
export function runArch(args: readonly string[], cwd: string = process.cwd()): void {
  const refusal = archctxRefusal(args);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = runArchctxPassThrough(cwd, args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
