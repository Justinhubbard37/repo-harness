import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHCTX_COMMAND_DISPOSITIONS, ARCHCTX_REQUIRED_VERSION, archctxRefusal } from '../../src/core/architecture/projection';
import { resolveCompatibleNodeRuntime, resolvePackageLocalArchctx, runArchctxPassThrough } from '../../src/effects/architecture/archctx-provider';
import { pluginSelectionEnv, recordPluginSelection } from '../helpers/install-ownership';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A package-local archctx at the required version: `resolve` exits by path, other commands record their argv. */
function fakeConsumer(): { root: string; argvFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-arch-'));
  roots.push(root);
  const packageRoot = join(root, 'node_modules', 'archctx');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'archctx', version: ARCHCTX_REQUIRED_VERSION, engines: { node: '>=22.22 <26' }, bin: { archctx: './bin/archctx' } })}\n`);
  const argvFile = join(root, 'argv.json');
  const binary = join(packageRoot, 'bin', 'archctx');
  writeFileSync(binary, `#!/usr/bin/env node
const [command, ...rest] = process.argv.slice(2);
if (command === 'capabilities') {
  console.log(JSON.stringify({ schemaVersion: 'archcontext.capabilities/v1', package: { name: 'archctx', version: ${JSON.stringify(ARCHCTX_REQUIRED_VERSION)} } }));
} else if (command === 'resolve') {
  process.exit(rest.includes('unowned') ? 1 : 2);
} else {
  require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify([command, ...rest]));
  process.exit(7);
}
`);
  chmodSync(binary, 0o755);
  return { root, argvFile };
}

describe('rh arch', () => {
  test('the disposition table has one entry for each command of the pinned archctx help', () => {
    const { binaryPath } = resolvePackageLocalArchctx();
    const help = JSON.parse(execFileSync(resolveCompatibleNodeRuntime(process.env), [binaryPath, 'help', '--json'], { encoding: 'utf8' })) as { data: { commands: string[] } };
    expect(Object.keys(ARCHCTX_COMMAND_DISPOSITIONS).sort()).toEqual([...help.data.commands, 'docs'].sort());
  });

  test('refuses an unknown, owned, refused or held command and lets the read-only projection subcommands through', () => {
    expect(archctxRefusal(['nosuch'])).toBe('arch_command_unknown: nosuch');
    expect(archctxRefusal(['install', '--host', 'codex'])).toBe('arch_command_refused: install. Use: rh install');
    expect(archctxRefusal(['audit', 'run'])).toStartWith('arch_command_held: audit.');
    expect(archctxRefusal(['recommendations'])).toBe('arch_command_owned: recommendations. Use: rh arch refactor');
    expect(archctxRefusal(['projection', 'run'])).toBe('arch_command_owned: projection run. Use: rh arch projection check|plan|apply');
    expect(archctxRefusal(['projection', 'nosuch'])).toBe('arch_command_unknown: projection nosuch');
    for (const sub of ['snapshot', 'freshness', 'publish-status', 'verify-pr']) expect(archctxRefusal(['projection', sub, '--json'])).toBeNull();
    expect(archctxRefusal(['validate', '--format', 'json'])).toBeNull();
  });

  test('passes the arguments unchanged and returns the archctx exit code', () => {
    const { root, argvFile } = fakeConsumer();
    const options = { consumerRoot: root, policy: { provider: 'archctx', applyMode: 'manual', requiredVersion: ARCHCTX_REQUIRED_VERSION, timeoutMs: 120_000 } } as const;
    expect(runArchctxPassThrough(root, ['validate', '--format', 'json'], options)).toBe(7);
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['validate', '--format', 'json']);
    expect(runArchctxPassThrough(root, ['resolve', '--path', 'unowned'], options)).toBe(1);
    expect(runArchctxPassThrough(root, ['resolve', '--path', 'ambiguous'], options)).toBe(2);
  });

  test('the command starts no process for a refusal and needs the architecture plugin', () => {
    const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, 'arch', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
    const selected = pluginSelectionEnv(['architecture']);
    expect(run(selected, 'nosuch')).toMatchObject({ status: 2, stderr: 'arch_command_unknown: nosuch\n' });
    expect(run(selected, 'install', '--host', 'codex').status).toBe(2);
    const without = run(pluginSelectionEnv([]), 'validate');
    expect(without.status).not.toBe(0);
    expect(without.stderr).toContain('install_plugin_unavailable');
  });

  test('the architecture commands run under rh arch, and their old top-level names are unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-arch-cli-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(join(home, '.repo-harness'), { recursive: true });
    writeFileSync(join(home, '.repo-harness', 'config.json'), JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'manual' } }));
    recordPluginSelection({ HOME: home });
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000 });
    // archctx answers verify-pr itself; outside a Git worktree it reports its own error.
    const verify = run('arch', 'projection', 'verify-pr', '--base', 'origin/main', '--json');
    expect(JSON.parse(verify.stdout)).toMatchObject({ schemaVersion: 'archcontext.envelope/v1', requestId: 'projection.verify-pr' });
    expect(run('arch', 'projection', 'run', '--request-json', '{}')).toMatchObject({ status: 2, stderr: 'arch_command_owned: projection run. Use: rh arch projection check|plan|apply\n' });
    for (const args of [['architecture-projection', 'status', '--json'], ['architecture-debt'], ['module', 'list'], ['refactor', 'recommendations'], ['tools', 'ensure', 'codegraph']]) {
      expect(run(...args)).toMatchObject({ status: 1, stderr: `error: unknown command '${args[0]}'\n` });
    }
  }, 60_000);
});
