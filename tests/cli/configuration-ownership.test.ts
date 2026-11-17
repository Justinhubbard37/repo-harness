import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configurationReceiptPath, readConfigurationReceipt, recordConfigurationChange, withConfigurationMutation, writePrivateConfiguration } from '../../src/cli/installer/configuration-ownership';
import { codexConfigFragment, tomlFragment } from '../../src/core/host-config/toml-fragment';
import { planFile } from '../../src/core/host-config/plan';
import { acquireRuntimeTransactionLock, globalRuntimeScope, runtimeTransactionRoot, withRuntimeTransactionLock } from '../../src/effects/locking/runtime-transaction-lock';

function fixture(run: (home: string, env: NodeJS.ProcessEnv) => void) {
  const home = mkdtempSync(join(tmpdir(), 'configuration-ownership-'));
  try { run(home, { HOME: home }); } finally { rmSync(home, { recursive: true, force: true }); }
}
function writeOwnedConfiguration(path: string, content: string, root: string): void {
  withConfigurationMutation([path], root, () => writePrivateConfiguration(path, content, root));
}
const claudeJson = (server: string) => `${JSON.stringify({ mcpServers: { codegraph: { command: server } } }, null, 2)}\n`;

test('issue 698 TOML fragment selects the root key and preserves profile keys', () => {
  const raw = 'default_mode_request_user_input = false\n[profiles.work]\ndefault_mode_request_user_input = false\n';
  expect(codexConfigFragment(raw, 'default_mode_request_user_input')).toBe('default_mode_request_user_input = false\n');
  const { result } = planFile('config.toml', raw, [{ owner: 'core', selector: 'default_mode_request_user_input', kind: 'override', selected: true, strategy: tomlFragment, value: 'default_mode_request_user_input = true\n' }], []);
  expect(result).toBe('default_mode_request_user_input = true\n[profiles.work]\ndefault_mode_request_user_input = false\n');
});

test('an appended CodeGraph table refreshes as rh text and its removal gives back the exact bytes, with or without a final newline', () => {
  const table = '[mcp_servers.codegraph]\ncommand = "cg"\n';
  const request = (kind: 'add' | 'refresh', value: string) => ({ owner: 'architecture', selector: 'mcp_servers.codegraph', kind, strategy: tomlFragment, value });
  for (const raw of ['model = "user"', 'model = "user"\n']) {
    const added = planFile('config.toml', raw, [request('add', table)], []);
    const record = { file: 'config.toml', owner: 'architecture', selector: 'mcp_servers.codegraph', kind: 'add' as const, inserted: added.fragments[0]!.edit.inserted };
    const refreshed = planFile('config.toml', added.result, [request('refresh', table)], [record]);
    expect({ skipped: refreshed.skipped, unchanged: refreshed.result === added.result }, JSON.stringify(raw)).toEqual({ skipped: [], unchanged: true });
    expect(planFile('config.toml', added.result, [request('refresh', '')], [record]).result).toBe(raw);
  }
});

test('issue 698 ambiguous top-level TOML keys refuse a fragment mutation', () => {
  for (const raw of ['default_mode_request_user_input = false\ndefault_mode_request_user_input = true\n', '"default_mode_request_user_input" = false\n']) {
    expect(() => tomlFragment.apply(raw, 'default_mode_request_user_input', 'default_mode_request_user_input = true\n')).toThrow();
  }
});
test('records earliest original and private receipt across repeat installs', () => fixture((home, env) => {
  const path = join(home, '.claude.json');
  writeFileSync(path, claudeJson('original'));
  writeOwnedConfiguration(path, claudeJson('rh'), home);
  writeOwnedConfiguration(path, readFileSync(path, 'utf8'), home);
  expect(readConfigurationReceipt(home).changes).toHaveLength(1);
  expect(readConfigurationReceipt(home).changes[0]!.before).toBe(JSON.stringify({ command: 'original' }));
  expect(statSync(configurationReceiptPath(home)).mode & 0o777).toBe(0o600);
}));
test('refuses a configuration receipt with the retired Codex MCP selector', () => fixture((home) => {
  mkdirSync(join(home, '.repo-harness'));
  writeFileSync(configurationReceiptPath(home), JSON.stringify({
    protocol: 1,
    changes: [{ path: join(home, '.codex/config.toml'), selector: 'mcp_servers.repo_harness', before: null, installed: null, active: true }],
  }));
  expect(() => readConfigurationReceipt(home)).toThrow(`invalid configuration receipt entry: ${configurationReceiptPath(home)}`);
}));
test('refuses receipt path symlinks before writing configuration', () => fixture((home, env) => {
  mkdirSync(join(home, '.repo-harness'));
  const victim = join(home, 'victim'); writeFileSync(victim, 'untouched');
  symlinkSync(victim, configurationReceiptPath(home));
  expect(() => writeOwnedConfiguration(join(home, '.claude.json'), claudeJson('rh'), home)).toThrow();
  expect(readFileSync(victim, 'utf8')).toBe('untouched');
  expect(existsSync(join(home, '.claude.json'))).toBe(false);
}));
test('rejects modified original before overwriting it', () => fixture((home, env) => {
  const path = join(home, '.claude.json');
  writeOwnedConfiguration(path, claudeJson('rh'), home);
  writeFileSync(path, claudeJson('user'));
  expect(() => writeOwnedConfiguration(path, claudeJson('rh'), home)).toThrow('changed since installation');
  expect(readFileSync(path, 'utf8')).toContain('user');
}));
test('records only CodeGraph keys, never sibling secrets', () => fixture((home, env) => {
  const path = join(home, '.claude.json');
  recordConfigurationChange(path, JSON.stringify({ secret: 'dont-copy', mcpServers: { user: { command: 'user' } } }), JSON.stringify({ secret: 'dont-copy', mcpServers: { user: { command: 'user' }, codegraph: { command: 'cg' } } }), home);
  expect(readFileSync(configurationReceiptPath(home), 'utf8')).not.toContain('dont-copy');
  expect(readConfigurationReceipt(home).changes[0]!.selector).toBe('mcpServers.codegraph');
}));

test('interrupted external writer retains durable preimage and blocks implicit cleanup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-kill-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  try {
    const path = join(home, '.claude.json');
    const original = `${JSON.stringify({ model: 'original' }, null, 2)}\n`;
    writeFileSync(path, original);
    const modulePath = join(import.meta.dir, '../../src/cli/installer/configuration-ownership.ts');
    const child = Bun.spawn(['bun', '-e', `import {withConfigurationMutation} from ${JSON.stringify(modulePath)}; import {writeFileSync} from 'fs'; withConfigurationMutation([${JSON.stringify(path)}], process.env.HOME, () => {writeFileSync(${JSON.stringify(path)}, JSON.stringify({ model: 'original', mcpServers: { codegraph: { command: 'cg' } } })); process.kill(process.pid, 'SIGKILL');});`], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).not.toBe(0);
    const receipt = readConfigurationReceipt(home);
    expect(JSON.stringify(receipt.pending)).not.toContain('model');
    expect(receipt.pending?.before.find(entry => entry.selector === 'mcpServers.codegraph')?.value).toBe(null);
    const before = readFileSync(path, 'utf8');
    const { runUserUninstall } = await import('../../src/cli/installer/uninstall');
    expect(runUserUninstall({ target: 'both', env }).status).toBe('partial');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() => writeOwnedConfiguration(path, claudeJson('replacement'), home)).toThrow('interrupted');
    const receiptBefore = readFileSync(configurationReceiptPath(home), 'utf8');
    expect(runUserUninstall({target:'both',env,dryRun:true,recoverInterrupted:true}).status).toBe('complete');
    expect(readFileSync(configurationReceiptPath(home), 'utf8')).toBe(receiptBefore);
    expect(runUserUninstall({target:'both',env,recoverInterrupted:true}).status).toBe('complete');
    expect(readFileSync(path,'utf8')).toBe(original);
    expect(readConfigurationReceipt(home).pending).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('shared host lock serializes concurrent writers and retains both host receipts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-lock-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  try {
    const modulePath = join(import.meta.dir, '../../src/cli/installer/configuration-ownership.ts');
    const lockPath = join(import.meta.dir, '../../src/effects/locking/runtime-transaction-lock.ts');
    const signal = join(home, 'locked');
    const code = (host: string, delay: number) => {
      const target = JSON.stringify(join(home, host === 'settings' ? '.claude/settings.json' : '.claude.json'));
      return `import {globalRuntimeScope, withRuntimeTransactionLock} from ${JSON.stringify(lockPath)}; import {withConfigurationMutation, writePrivateConfiguration} from ${JSON.stringify(modulePath)}; import {writeFileSync} from 'fs'; withRuntimeTransactionLock(globalRuntimeScope(process.env),()=>{writeFileSync(${JSON.stringify(signal)},'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delay}); withConfigurationMutation([${target}],process.env.HOME,()=>writePrivateConfiguration(${target},'{"mcpServers":{"codegraph":{"command":"cg"}}}',process.env.HOME));});`;
    };
    const first = Bun.spawn(['bun', '-e', code('settings', 500)], { env, stdout: 'pipe', stderr: 'pipe' });
    const deadline = Date.now() + 3000;
    while (!existsSync(signal) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(signal)).toBe(true);
    const second = Bun.spawn(['bun', '-e', code('claude', 0)], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await second.exited).toBe(0);
    expect(await first.exited).toBe(0);
    const retry = Bun.spawn(['bun', '-e', code('claude', 0)], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await retry.exited).toBe(0);
    expect(readConfigurationReceipt(home).changes).toHaveLength(2);
    const { runUserUninstall } = await import('../../src/cli/installer/uninstall');
    expect(runUserUninstall({ target: 'both', env }).status).toBe('complete');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('issue 922 the account scope keeps global-runtime.lock', () => fixture((home, env) => {
  const global = globalRuntimeScope(env);
  expect(global).toEqual({ kind: 'global', root: home });
  expect(runtimeTransactionRoot(global)).toBe(join(home, '.repo-harness', 'transactions'));
  withRuntimeTransactionLock(global, (lock) => {
    expect(lock.lockPath).toBe(join(realpathSync(home), '.repo-harness/transactions/global-runtime.lock'));
  });
}));


test('candidate parent context accepts EPERM, rejects ESRCH and preserves unexpected probe errors', () => fixture((home) => {
  const lock = acquireRuntimeTransactionLock({ kind: 'global', root: home });
  try {
    const modulePath = join(import.meta.dir, '../../src/effects/locking/runtime-transaction-lock.ts');
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { strict as assert } from 'assert';
      import { parentRuntimeTransactionContext } from ${JSON.stringify(modulePath)};
      const scope = { kind: 'global', root: ${JSON.stringify(home)} };
      const parent = ${JSON.stringify({ pid: process.pid, lockPath: lock.lockPath, ownerToken: lock.ownerToken })};
      for (const code of ['EPERM', 'ESRCH', 'EIO']) {
        const failure = Object.assign(new Error(code), { code });
        process.kill = () => { throw failure; };
        const create = () => parentRuntimeTransactionContext(scope, parent);
        if (code === 'EPERM') create().assertOwned();
        else if (code === 'ESRCH') assert.throws(create, /candidate parent no longer owns the global runtime lock/);
        else assert.throws(create, error => error === failure);
      }
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally { lock.release(); }
}));

test('installer rollback refuses a competing configuration writer before it can report success', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-rollback-lock-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const path = join(home, '.repo-harness/config.json');
  const modulePath = join(import.meta.dir, '../../src/effects/configuration/global-configuration.ts');
  const code = `import {mutateGlobalConfiguration} from ${JSON.stringify(modulePath)}; try { mutateGlobalConfiguration(process.env, (config) => ({ config: { ...config, security: { mode: 'relaxed' } }, value: undefined })); } catch (error) { console.error(error.code); process.exit(75); }`;
  const { beginInstallHostTransaction, rollbackInstallHostTransaction } = await import('../../src/cli/installer/install-profile');
  try {
    mkdirSync(join(home, '.repo-harness'));
    const original = JSON.stringify({ security: { mode: 'strict' } });
    writeFileSync(path, original);
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(env));
    try {
      const transaction = beginInstallHostTransaction([path], env, { runtimeLock: lock });
      const child = Bun.spawn([process.execPath, '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(75);
      expect(stderr).toContain('busy');
      expect(readFileSync(path, 'utf8')).toBe(original);
      lock.assertOwned();
      rollbackInstallHostTransaction(transaction);
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally { lock.release(); }
    const child = Bun.spawn([process.execPath, '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ security: { mode: 'relaxed' } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('failed commit cleanup retains its lock and permits rollback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-commit-cleanup-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const path = join(home, '.repo-harness/config.json');
  const { beginInstallHostTransaction, commitInstallHostTransaction, rollbackInstallHostTransaction } = await import('../../src/cli/installer/install-profile');
  let transaction: ReturnType<typeof beginInstallHostTransaction> | undefined;
  try {
    mkdirSync(join(home, '.repo-harness'));
    const original = JSON.stringify({ security: { mode: 'strict' } });
    writeFileSync(path, original);
    transaction = beginInstallHostTransaction([path], env);
    writeFileSync(path, JSON.stringify({ security: { mode: 'during-install' } }));
    chmodSync(transaction.backup_root, 0o500);
    try {
      expect(() => commitInstallHostTransaction(transaction!)).toThrow();
    } finally { if (existsSync(transaction.backup_root)) chmodSync(transaction.backup_root, 0o700); }
    const modulePath = join(import.meta.dir, '../../src/effects/configuration/global-configuration.ts');
    const child = Bun.spawn([process.execPath, '-e', `import {mutateGlobalConfiguration} from ${JSON.stringify(modulePath)}; try { mutateGlobalConfiguration(process.env, (config) => ({ config: { ...config, security: { mode: 'competing' } }, value: undefined })); } catch (error) { console.error(error.code); process.exit(75); }`], { env, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(75);
    expect(stderr).toContain('busy');
    rollbackInstallHostTransaction(transaction);
    transaction = undefined;
    expect(readFileSync(path, 'utf8')).toBe(original);
    const { mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
    mutateGlobalConfiguration(env, (config) => ({ config: { ...config, security: { mode: 'after-rollback' } }, value: undefined }));
    expect(JSON.parse(readFileSync(path, 'utf8')).security.mode).toBe('after-rollback');
  } finally {
    if (transaction && existsSync(transaction.backup_root)) {
      chmodSync(transaction.backup_root, 0o700);
      rollbackInstallHostTransaction(transaction);
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('configuration writes preserve sibling sections and reject invalid input or foreign lock contexts', async () => {
  const { ensureGlobalArchitectureProjection } = await import('../../src/cli/commands/architecture-configuration');
  const { applyAgentsSettings } = await import('../../src/effects/configuration/agents-configuration');
  const { globalConfigurationWriter, readGlobalConfiguration, mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
  fixture((home, env) => {
    const path = join(home, '.repo-harness/config.json');
    mkdirSync(join(home, '.repo-harness'));
    writeFileSync(path, JSON.stringify({ security: { mode: 'strict' } }));
    expect(ensureGlobalArchitectureProjection(env, globalConfigurationWriter(env)).status).toBe('ok');
    const before = readGlobalConfiguration(env);
    // A review use is a valid agents write; a new docs use is refused while no runtime has verified docs isolation.
    applyAgentsSettings({ expected_revision: before.revision, changes: [{ runtime: 'codex', enabled: true, uses: ['review'] }] }, ['codex'], env);
    const result = readGlobalConfiguration(env);
    expect(result.config).toMatchObject({ security: { mode: 'strict' }, architecture: { projection_provider: 'archctx' }, agents: { enabled: ['codex'], uses: { review: ['codex'] } } });
    expect(() => applyAgentsSettings({ expected_revision: before.revision, changes: [] }, ['codex'], env)).toThrow('changed after it was read');
    expect(readGlobalConfiguration(env).revision).toBe(result.revision);
    expect(() => mutateGlobalConfiguration(env, () => ({ config: {}, value: undefined }), {
      runtimeLock: { scope: globalRuntimeScope(env), assertOwned() {} },
    })).toThrow('does not own this scope');
    expect(readGlobalConfiguration(env).revision).toBe(result.revision);
    writeFileSync(path, '{invalid');
    expect(() => mutateGlobalConfiguration(env, () => ({ config: {}, value: undefined }))).toThrow('not a valid JSON object');
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
  });
});


test.skipIf(process.platform !== 'win32')('Windows explicit configuration targets share the account lock', async () => {
  const { mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
  const write = (env: NodeJS.ProcessEnv, mode: string) => mutateGlobalConfiguration(env, (config) => ({ config: { ...config, security: { mode } }, value: undefined }));
  fixture((home) => {
    const firstHome = join(home, 'first');
    const secondHome = join(home, 'second');
    mkdirSync(firstHome); mkdirSync(secondHome);
    const first = { HOME: firstHome }, second = { HOME: secondHome };
    expect(globalRuntimeScope(first)).toEqual(globalRuntimeScope(second));
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(first));
    try {
      expect(() => write(second, 'locked')).toThrow('runtime transaction');
      expect(existsSync(join(firstHome, '.repo-harness/config.json'))).toBe(false);
      expect(existsSync(join(secondHome, '.repo-harness/config.json'))).toBe(false);
    } finally { lock.release(); }
    const result = write(second, 'unlocked');
    expect(result.path).toBe(join(secondHome, '.repo-harness/config.json'));
    expect(JSON.parse(readFileSync(result.path, 'utf8')).security.mode).toBe('unlocked');
    expect(existsSync(join(firstHome, '.repo-harness/config.json'))).toBe(false);
  });
});
