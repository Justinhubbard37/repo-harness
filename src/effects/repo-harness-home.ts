// No project imports: `herdr notify install` loads this module through a chain that plain Node also runs.
import { isAbsolute, join, resolve } from "node:path";

/** An explicit HOME is required before resolving an account write path. */
export function requireHome(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error('HOME is required and must be an absolute path');
  return env.HOME;
}

/** The single account-level harness home; every host-owned authority store roots here. */
export function repoHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.REPO_HARNESS_HOME ?? join(requireHome(env), ".repo-harness"));
}
