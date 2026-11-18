import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { pluginSelectionEnv, recordPluginSelection, seedGlobalPackageFixture } from "../helpers/install-ownership";
import { writeShellExecutableFixture } from "../helpers/repo-fixture";
import { requestUserInputFragment } from "../../src/cli/installer/targets/codex";
import { openHostConfigGate } from "../../src/effects/host-config/gate";
import { acquireRuntimeTransactionLock, globalRuntimeScope } from "../../src/effects/locking/runtime-transaction-lock";
import { buildManagedHooks } from "../../src/cli/installer/managed-entries";
import { jsonFragment } from "../../src/core/host-config/json-fragment";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src/cli/index.ts");

function writeExecutable(temporaryRoot: string, filePath: string, content: string) {
  writeShellExecutableFixture(temporaryRoot, filePath, content);
}

function setupFakeEnvironment(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, "home");
  const fakeBin = join(root, "fakebin");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  recordPluginSelection({ HOME: home });
  return { root, home, fakeBin };
}

function writeFakeCodeGraph(fakeBin: string, logFile: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "codegraph"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `echo "codegraph $*" >> "${logFile}"`,
      "case \"${1:-}\" in",
      "  \"--version\") echo '0.9.6' ;;",
      "  \"status\") echo 'CodeGraph Status'; echo 'Index is up to date' ;;",
      "  \"init\"|\"sync\"|\"install\") echo 'unexpected mutation' >&2; exit 2 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n")
  );
}

// check-agent-tooling.sh resolves `skills` from PATH (and only spawns it under
// --probe-skills-cli), so the stub has to be the binary itself, not bunx.
function writeFakeSkillsCli(fakeBin: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "skills"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "if [[ \"$*\" == \"ls -g --json\" ]]; then echo '[]'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n")
  );
}

describe("arch codegraph ensure", () => {
  test("--check is read-only and exposes the shared readiness report", () => {
    const envRoot = setupFakeEnvironment("repo-harness-tools-codegraph");
    const logFile = join(envRoot.root, "tool.log");
    try {
      mkdirSync(join(envRoot.home, ".codex"), { recursive: true });
      writeFileSync(join(envRoot.home, ".codex", "config.toml"), "[mcp_servers.codegraph]\ncommand = \"codegraph\"\n");
      writeFakeCodeGraph(envRoot.fakeBin, logFile);
      writeFakeSkillsCli(envRoot.fakeBin);

      const res = spawnSync("bun", [CLI, "arch", "codegraph", "ensure", "--check", "--json", "--repo", ROOT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: envRoot.home,
          PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}`,
          REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: "0",
        },
      });

      expect(res.status).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(result.read_only).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.codegraph.name).toBe("codegraph");
      expect(result.codegraph.source).toBe("global");
      expect(result.actions).toEqual([]);

      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("codegraph --version");
      expect(log).toContain("codegraph status .");
      expect(log).not.toContain("codegraph init");
      expect(log).not.toContain("codegraph sync");
      expect(log).not.toContain("codegraph install");
    } finally {
      rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, 15000);

  test("human output names CodeGraph status", () => {
    const res = spawnSync("bun", [CLI, "arch", "codegraph", "ensure", "--check"], {
      cwd: ROOT,
      env: pluginSelectionEnv(),
      encoding: "utf-8",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("CodeGraph:");
    expect(res.stdout).toContain("Source:");
  }, 15000);
});

test('standalone CodeGraph configure writes the Codex table through the gate, and uninstall reverts it', () => {
  const fixture = setupFakeEnvironment('standalone-codegraph-uninstall');
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    const codegraph = join(fixture.fakeBin, 'codegraph');
    writeExecutable(fixture.root, codegraph, [
      '#!/bin/bash',
      'set -euo pipefail',
      'case "${1:-}" in',
      '  --version) echo "0.9.6" ;;',
      '  status) echo "CodeGraph Status"; echo "Index is up to date" ;;',
      // codegraph 1.6.2 prints this snippet for `install --print-config codex` and writes nothing.
      '  install) [[ "$*" == "install --print-config codex" ]] || exit 2; printf \'%s\\n\' "# Add to $HOME/.codex/config.toml" "" \'[mcp_servers.codegraph]\' \'command = "codegraph"\' \'args = ["serve", "--mcp"]\' ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    mkdirSync(join(fixture.home, '.codex'));
    writeFileSync(join(fixture.home, '.codex/config.toml'), 'model = "user-model"\n');
    // The `core` fragment is in place before the `architecture` owner writes its table (A7).
    openHostConfigGate({ env: { HOME: fixture.home } }).apply([{ path: join(fixture.home, '.codex/config.toml'), fragments: [requestUserInputFragment('model = "user-model"\n')!] }]);
    const env = { ...process.env, HOME: fixture.home, PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    const configured = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'codex', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(configured.status, configured.stderr).toBe(0);
    expect(JSON.parse(configured.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-codex', 'changed']]);
    const section = '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp", "--path", "."]\n';
    expect(readFileSync(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe(`default_mode_request_user_input = true\nmodel = "user-model"\n${section}`);
    const ledger = readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8');
    expect(JSON.parse(ledger).fragments.map((entry: any) => [entry.owner, entry.selector, entry.inserted]))
      .toEqual([['core', 'default_mode_request_user_input', 'default_mode_request_user_input = true\n'], ['architecture', 'mcp_servers.codegraph', section]]);
    expect(JSON.parse(ledger).files[realpathSync(join(fixture.home, '.codex/config.toml'))].external_change).toBe(false);
    expect(ledger).not.toContain('user-model');
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'codex', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect(readFileSync(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe('model = "user-model"\n');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 15000);

/** A fake codegraph whose `install --print-config claude` prints a server object with this command and writes nothing. */
function writeClaudePrintingCodegraph(fakeBin: string, command: string) {
  writeExecutable(fakeBin, join(fakeBin, 'codegraph'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'case "${1:-}" in',
    '  --version) echo "0.9.6" ;;',
    '  status) echo "CodeGraph Status"; echo "Index is up to date" ;;',
    // codegraph 1.6.2 prints this object for `install --print-config claude` and writes nothing.
    `  install) [[ "$*" == "install --print-config claude" ]] || exit 2; printf '%s\\n' "# Add to $HOME/.claude.json" "" '${JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command, args: ['serve', '--mcp'], alwaysLoad: true } } })}' ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
}

test('standalone CodeGraph configure for Claude writes its server and tool rule through the gate, refreshes its own server, keeps no copy of ~/.claude.json, and uninstall reverts both', () => {
  const fixture = setupFakeEnvironment('standalone-codegraph-claude');
  const fakeCodegraph = (command: string) => writeClaudePrintingCodegraph(fixture.fakeBin, command);
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    fakeCodegraph('codegraph');
    const rootConfig = join(fixture.home, '.claude.json');
    const settings = join(fixture.home, '.claude/settings.json');
    const rootBefore = '{\n    "primaryApiKey": "sk-test-not-a-key",\n    "numStartups": 3\n}\n';
    mkdirSync(join(fixture.home, '.claude'));
    writeFileSync(rootConfig, rootBefore);
    // An earlier rh version wrote the tool rule into top-level allowedTools and recorded it in its receipt.
    // The migration cannot prove that rh created the allowedTools array, so it stays, empty.
    const settingsAfter = '{"permissions":{"allow":["Bash(ls)"]},"allowedTools":[]}';
    writeFileSync(settings, '{"permissions":{"allow":["Bash(ls)"]},"allowedTools":["mcp__codegraph__*"]}');
    mkdirSync(join(fixture.home, '.repo-harness'), { recursive: true });
    writeFileSync(join(fixture.home, '.repo-harness/configuration-restore.json'), JSON.stringify({ protocol: 1, changes: [
      { path: settings, selector: 'allowedTools.codegraph', before: null, installed: JSON.stringify('mcp__codegraph__*'), active: true },
    ] }));
    const env = { ...process.env, HOME: fixture.home, PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    const configured = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(configured.status, configured.stderr).toBe(0);
    expect(JSON.parse(configured.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-claude', 'changed'], ['claude-tool-permission', 'changed']]);
    expect(JSON.parse(readFileSync(rootConfig, 'utf8')).mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp', '--path', '.'], alwaysLoad: true });
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)', 'mcp__codegraph__*'] }, allowedTools: [] });
    // C3 (owner): rh's add to ~/.claude.json keeps no whole-file copy, so the login key is in no rh file.
    const ledger = JSON.parse(readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8'));
    expect(ledger.files[realpathSync(rootConfig)]).toMatchObject({ kind: 'text_block', backup: null });
    for (const name of readdirSync(join(fixture.home, '.repo-harness/config/vault'))) {
      expect(readFileSync(join(fixture.home, '.repo-harness/config/vault', name), 'utf8')).not.toContain('sk-test-not-a-key');
    }
    expect(existsSync(join(fixture.home, '.repo-harness/configuration-restore.json'))).toBe(false);
    // A later codegraph prints another server object: rh refreshes the server that it recorded, and its record follows.
    fakeCodegraph('/opt/codegraph/bin/codegraph');
    const refreshed = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-claude', 'changed'], ['claude-tool-permission', 'unchanged']]);
    const rootAfter = readFileSync(rootConfig, 'utf8');
    expect(JSON.parse(rootAfter).mcpServers.codegraph).toEqual({ type: 'stdio', command: '/opt/codegraph/bin/codegraph', args: ['serve', '--mcp', '--path', '.'], alwaysLoad: true });
    const range = jsonFragment.locate(rootAfter, 'mcpServers.codegraph')!;
    const recorded = JSON.parse(readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8')).fragments.find((entry: any) => entry.file === realpathSync(rootConfig));
    expect(recorded).toMatchObject({ selector: 'mcpServers.codegraph', kind: 'add', inserted: rootAfter.slice(range.start, range.end) });
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'claude', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect(readFileSync(rootConfig, 'utf8')).toBe(rootBefore);
    expect(readFileSync(settings, 'utf8')).toBe(settingsAfter);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 15000);

test('a concurrent rh install and CodeGraph configure for Claude serialize on the global lock, and the ledger keeps the records of both', async () => {
  const fixture = setupFakeEnvironment('concurrent-claude-writers');
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    writeClaudePrintingCodegraph(fixture.fakeBin, 'codegraph');
    const rootConfig = join(fixture.home, '.claude.json');
    const settings = join(fixture.home, '.claude/settings.json');
    mkdirSync(join(fixture.home, '.claude'));
    writeFileSync(rootConfig, '{"numStartups":1}\n');
    writeFileSync(settings, '{"theme":"user"}\n');
    const env = { ...process.env, HOME: fixture.home, BUN_INSTALL: join(fixture.home, '.bun'), PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    seedGlobalPackageFixture(env);
    // Both writers start while the test holds the lock, so each one waits for it.
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(env));
    let writers: ReturnType<typeof Bun.spawn>[];
    try {
      writers = [
        Bun.spawn(['bun', CLI, 'install', '--target', 'claude', '--location', 'global'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' }),
        Bun.spawn(['bun', CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' }),
      ];
    } finally { lock.release(); }
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0]);
    const gate = openHostConfigGate({ env });
    const selectors = gate.recorded(settings).map((entry) => entry.selector);
    expect(selectors).toContain('permissions.allow[mcp__codegraph__*]');
    expect(selectors).toContain('statusLine');
    expect(selectors.filter((selector) => selector.startsWith('hooks.')).length).toBe(Object.values(buildManagedHooks('claude', env)).flat().length);
    expect(gate.recorded(rootConfig).map((entry) => entry.selector)).toEqual(['mcpServers.codegraph']);
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'claude', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect([readFileSync(rootConfig, 'utf8'), readFileSync(settings, 'utf8')]).toEqual(['{"numStartups":1}\n', '{"theme":"user"}\n']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 30000);
