import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botRegistryPath, registerBot } from '../../src/effects/bot-registry';

const CLI = join(import.meta.dir, '../../src/cli/index.ts');
const NOW = new Date('2026-11-17T00:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function account() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rh-bots-cli-')));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { HOME: join(root, 'home'), REPO_HARNESS_HOME: join(root, 'home', '.repo-harness') };
  const rh = (...args: string[]) => {
    const result = Bun.spawnSync(['bun', CLI, 'bots', ...args], { env: { ...process.env, ...env } });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return { root, env, rh };
}

describe('rh bots list and show', () => {
  test('read the registry sorted by id, with no absolute path in the output', () => {
    const { root, env, rh } = account();
    const empty = rh('list', '--json');
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ kind: 'repo-harness.bots', protocol: 1, bots: [] });
    const hermes = registerBot({ bot_id: 'hermes', name: 'Hermes', host: 'Hermes', herdr_agent: 'hermes', now: NOW }, env);
    const dot = registerBot({ bot_id: 'dot', name: 'Dot', host: 'Dot', now: NOW }, env);
    // `dot-bot.json` sorts before `dot.json`; the id order puts `dot` first.
    const dotBot = registerBot({ bot_id: 'dot-bot', name: 'Dot Bot', host: 'Dot', now: NOW }, env);
    const listed = rh('list', '--json');
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ kind: 'repo-harness.bots', protocol: 1, bots: [dot, dotBot, hermes] });
    expect(listed.stdout).not.toContain(root);
    expect(rh('list').stdout).toBe('dot  Dot  Dot\ndot-bot  Dot Bot  Dot\nhermes  Hermes  Hermes\n');
    const shown = rh('show', 'hermes', '--json');
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(hermes);
  }, 60_000);

  test('an unknown id, an invalid id and a record that does not decode fail closed', () => {
    const { root, env, rh } = account();
    const hermes = registerBot({ bot_id: 'hermes', name: 'Hermes', host: 'Hermes', now: NOW }, env);
    const missing = rh('show', 'nosuch');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('bot_not_registered: nosuch');
    const badId = rh('show', '../escape');
    expect(badId.exitCode).toBe(2);
    expect(badId.stderr).toContain('bot_id_invalid');
    writeFileSync(join(botRegistryPath(env), 'broken.json'), '{"protocol":1');
    const corrupt = rh('list');
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.stderr).toContain('bot_registry_invalid: bot registry entry "broken.json" is invalid');
    rmSync(join(botRegistryPath(env), 'broken.json'));
    writeFileSync(join(botRegistryPath(env), 'hermes.json'), JSON.stringify({ ...hermes, mcp_client_id: null }));
    const retired = rh('list');
    expect(retired.exitCode).toBe(1);
    expect(retired.stderr).toContain('remove the key from "hermes.json"');
    expect(retired.stderr).not.toContain(root);
  }, 60_000);
});
