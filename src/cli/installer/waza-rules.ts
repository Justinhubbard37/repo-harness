import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import wazaRules from '../../core/skill-surface/waza-shared-rules.json';
import { runProcess } from '../../effects/process-runner';
import { withHostConfigTransaction } from './install-profile';
import { openHostConfigGate } from '../../effects/host-config/gate';
import { requireHome } from '../../effects/repo-harness-home';

interface RulesResult {
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
}

function readRule(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`refusing non-file rule ${path}`);
  return readFileSync(path, 'utf-8');
}

function fetchRules(env: NodeJS.ProcessEnv): Map<string, string> {
  const temporary = mkdtempSync(join(tmpdir(), 'repo-harness-waza-rules-'));
  try {
    const fetched = new Map<string, string>();
    for (const rule of wazaRules.files) {
      const url = `${wazaRules.rawBaseUrl}/rules/${rule}`;
      const output = join(temporary, rule);
      // Fetch to a file so process-output limits and redaction cannot change rule bytes.
      const result = runProcess('curl', ['-fsSL', '--max-time', '5', '--output', output, url], {
        env, timeoutMs: 7000,
      });
      if (!result.ok) {
        throw new Error(`cannot fetch Waza rule ${url}: ${result.stderr || result.error || `exit ${result.status}`}`);
      }
      const value = readRule(output);
      if (!value?.trim()) throw new Error(`cannot fetch Waza rule ${url}: empty response`);
      fetched.set(rule, value);
    }
    return fetched;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** True when no shared rule is staged. A rolled-back install can leave the empty directory. */
export function wazaStagingRulesAbsent(home: string): boolean {
  return wazaRules.files.every((rule) => lstatSync(join(home, '.agents', 'rules', rule), { throwIfNoEntry: false }) === undefined);
}

/** The gate owns rule writes; a fresh setup fetches only when staging is absent. */
export function syncWazaSharedRules(
  home: string | null,
  hosts: readonly ('claude' | 'codex')[],
  env: NodeJS.ProcessEnv,
  refreshMode: boolean | 'missing' = false,
  transaction?: string,
): RulesResult {
  if (!home) return { status: 'failed', detail: 'HOME is required' };
  const sourceDir = join(home, '.agents', 'rules');
  try {
    requireHome(env);
    const absent = wazaStagingRulesAbsent(home);
    const refresh = refreshMode === 'missing' ? absent : refreshMode;
    if (!refresh && absent) {
      return { status: 'skipped', detail: `staging rules not found: ${sourceDir}` };
    }
    const previous = new Map(wazaRules.files.map((rule) => [rule, readRule(join(sourceDir, rule))]));
    const next = refresh ? fetchRules(env) : previous;
    const missing = wazaRules.files.filter((rule) => next.get(rule) === undefined);
    if (missing.length > 0) return { status: 'failed', detail: `missing ${missing.join(', ')}` };

    const writes = [...(refresh ? [sourceDir] : []), ...hosts.map(host => join(home, '.' + host, 'rules'))]
      .flatMap(root => wazaRules.files.map(rule => ({ path: join(root, rule), owner: 'core',
        entry: { type: 'file' as const, bytes: Buffer.from(next.get(rule)!) } })));
    withHostConfigTransaction(env, transaction, root => openHostConfigGate({ env }).writePaths(writes, { transaction: root }));
    return { status: 'ok', detail: `${refresh ? 'refreshed staging; ' : ''}synced ${hosts.length * wazaRules.files.length} files` };
  } catch (error) {
    return { status: 'failed', detail: (error as Error).message };
  }
}
