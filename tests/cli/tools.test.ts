import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { recordPluginSelection } from "../helpers/install-ownership";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src/cli/index.ts");

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function setupFakeEnvironment(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, "home");
  const fakeBin = join(root, "fakebin");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  return { root, home, fakeBin };
}

function writeFakeCodeGraph(fakeBin: string, logFile: string) {
  writeExecutable(
    join(fakeBin, "codegraph"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `echo "codegraph $*" >> "${logFile}"`,
      "case \"${1:-}\" in",
      "  \"--version\") echo '0.9.6' ;;",
      "  \"status\") echo 'CodeGraph Status'; echo 'Index is up to date' ;;",
      "  \"install\")",
      // codegraph 1.6.2 prints this snippet for `install --print-config codex` and writes nothing.
      "    if [[ \"$*\" == \"install --print-config codex\" ]]; then",
      "      printf '%s\\n' \"# Add to $HOME/.codex/config.toml\" '' '[mcp_servers.codegraph]' 'command = \"codegraph\"' 'args = [\"serve\", \"--mcp\"]'",
      "      exit 0",
      "    fi",
      // codegraph 1.6.2 prints this object for `install --print-config claude` and writes nothing.
      "    if [[ \"$*\" == \"install --print-config claude\" ]]; then",
      "      printf '%s\\n' \"# Add to $HOME/.claude.json\" '' '{\"mcpServers\":{\"codegraph\":{\"type\":\"stdio\",\"command\":\"codegraph\",\"args\":[\"serve\",\"--mcp\"],\"alwaysLoad\":true}}}'",
      "      exit 0",
      "    fi",
      "    exit 2 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n")
  );
}

// check-agent-tooling.sh resolves `skills` from PATH (and only spawns it under
// --probe-skills-cli), so the stub has to be the binary itself, not bunx.
function writeFakeSkillsCli(fakeBin: string) {
  writeExecutable(
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

type RunConfigureOptions = {
  // null / undefined → seed empty {} settings.json so the claude-tool-permission
  // step has something to mutate. Pass "missing" to skip seeding entirely and
  // exercise the "no Claude Code installed" branch.
  seedClaudeSettings?: Record<string, unknown> | "missing" | null;
  seedClaudeRootConfig?: Record<string, unknown> | null;
};

function runConfigure(target: string, options: RunConfigureOptions = {}) {
  const envRoot = setupFakeEnvironment(`repo-harness-tools-configure-${target}`);
  const logFile = join(envRoot.root, "tool.log");
  const claudeSettingsPath = join(envRoot.home, ".claude", "settings.json");
  const claudeRootConfigPath = join(envRoot.home, ".claude.json");
  try {
    mkdirSync(join(envRoot.home, ".codex"), { recursive: true });
    writeFileSync(join(envRoot.home, ".codex", "config.toml"), "# no codegraph yet\n");

    const seed = options.seedClaudeSettings;
    if (seed !== "missing") {
      mkdirSync(dirname(claudeSettingsPath), { recursive: true });
      writeFileSync(claudeSettingsPath, `${JSON.stringify(seed ?? {}, null, 2)}\n`);
    }
    if (options.seedClaudeRootConfig) {
      writeFileSync(claudeRootConfigPath, `${JSON.stringify(options.seedClaudeRootConfig, null, 2)}\n`);
    }

    writeFakeCodeGraph(envRoot.fakeBin, logFile);
    writeFakeSkillsCli(envRoot.fakeBin);
    recordPluginSelection({ HOME: envRoot.home });

    const res = spawnSync("bun", [CLI, "arch", "codegraph", "configure", "--target", target, "--location", "global", "--json", "--repo", ROOT], {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: envRoot.home,
        PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}`,
        REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: "0",
      },
    });

    const log = readFileSync(logFile, "utf-8");
    let claudeSettingsAfter: any = null;
    let claudeRootConfigAfter: any = null;
    let codexConfigAfter = "";
    try {
      claudeSettingsAfter = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
    } catch (_error) {
      claudeSettingsAfter = null;
    }
    try {
      claudeRootConfigAfter = JSON.parse(readFileSync(claudeRootConfigPath, "utf-8"));
    } catch (_error) {
      claudeRootConfigAfter = null;
    }
    try {
      codexConfigAfter = readFileSync(join(envRoot.home, ".codex", "config.toml"), "utf-8");
    } catch (_error) {
      codexConfigAfter = "";
    }
    return { res, log, claudeSettingsAfter, claudeRootConfigAfter, codexConfigAfter };
  } finally {
    rmSync(envRoot.root, { recursive: true, force: true });
  }
}

describe("arch codegraph configure", () => {
  test("configures Codex through the CodeGraph target adapter", () => {
    const { res, log, codexConfigAfter } = runConfigure("codex");
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    expect(result.target).toBe("codex");
    expect(result.location).toBe("global");
    expect(result.actions.map((entry: { action: string }) => entry.action)).toEqual(["configure-codex"]);
    expect(log).toContain("codegraph install --print-config codex");
    expect(log).not.toContain("--target codex");
    expect(codexConfigAfter).toBe('# no codegraph yet\n[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp", "--path", "."]\n');
  }, 15000);

  test("configures Claude from the printed server object and allows the CodeGraph tools in permissions.allow", () => {
    const { res, log, claudeSettingsAfter, claudeRootConfigAfter } = runConfigure("claude");
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    expect(result.target).toBe("claude");
    expect(result.actions.map((entry: { action: string; status: string }) => [entry.action, entry.status])).toEqual([
      ["configure-claude", "changed"],
      ["claude-tool-permission", "changed"],
    ]);
    expect(log).toContain("codegraph install --print-config claude");
    expect(log).not.toContain("--target claude");
    expect(claudeRootConfigAfter?.mcpServers?.codegraph?.args).toEqual(["serve", "--mcp", "--path", "."]);
    expect(claudeRootConfigAfter?.mcpServers?.codegraph?.alwaysLoad).toBe(true);
    expect(claudeSettingsAfter).toEqual({ permissions: { allow: ["mcp__codegraph__*"] } });
  }, 15000);

  test("a CodeGraph server that rh did not write stays the user's", () => {
    const user = { type: "stdio", command: "codegraph", args: ["serve", "--mcp"] };
    const { res, claudeRootConfigAfter } = runConfigure("claude", { seedClaudeRootConfig: { mcpServers: { codegraph: user } } });
    expect(res.status).toBe(0);
    const configure = JSON.parse(res.stdout).actions.find((entry: { action: string }) => entry.action === "configure-claude");
    expect(configure?.status).toBe("skipped");
    expect(configure?.stderr ?? "").toContain("is your configuration; rh did not change it");
    expect(claudeRootConfigAfter?.mcpServers?.codegraph).toEqual(user);
  }, 15000);

  test("claude-tool-permission is unchanged when the rule is already in permissions.allow", () => {
    const { res, claudeSettingsAfter } = runConfigure("claude", {
      seedClaudeSettings: { permissions: { allow: ["Edit", "mcp__codegraph__*"] } },
    });
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    const permission = (result.actions as Array<{ action: string; status: string }>).find(
      (entry) => entry.action === "claude-tool-permission",
    );
    expect(permission?.status).toBe("unchanged");
    expect(claudeSettingsAfter).toEqual({ permissions: { allow: ["Edit", "mcp__codegraph__*"] } });
  }, 15000);

  test("claude-tool-permission is skipped when Claude Code is not installed", () => {
    const { res, claudeSettingsAfter } = runConfigure("claude", { seedClaudeSettings: "missing" });
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    const permission = (result.actions as Array<{ action: string; status: string; stderr?: string }>).find(
      (entry) => entry.action === "claude-tool-permission",
    );
    expect(permission?.status).toBe("skipped");
    expect(permission?.stderr ?? "").toContain("not found");
    expect(claudeSettingsAfter).toBeNull();
  }, 15000);

  test("configures both hosts without exposing host-specific tool call syntax", () => {
    const { res, log } = runConfigure("both");
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    expect(result.target).toBe("both");
    expect(result.actions.map((entry: { action: string }) => entry.action)).toEqual([
      "configure-codex",
      "configure-claude",
      "claude-tool-permission",
    ]);
    expect(log).toContain("codegraph install --print-config codex");
    expect(log).toContain("codegraph install --print-config claude");
    // CLI output may carry the host-agnostic wildcard mcp__codegraph__* as a
    // configuration value (it is the actual Claude permissions.allow entry). What it
    // must NOT carry is concrete codegraph tool invocations such as
    // codegraph_context(...), codegraph_callers(...) etc -- those belong to
    // agent prompts, not adapter output.
    expect(res.stdout).not.toMatch(/codegraph_\w+\s*\(/);
  }, 15000);
});

describe("architecture plugin guard", () => {
  test("each architecture command fails closed with the repair command before it starts a process", () => {
    const envRoot = setupFakeEnvironment("repo-harness-architecture-guard");
    const logFile = join(envRoot.root, "tool.log");
    try {
      writeFakeCodeGraph(envRoot.fakeBin, logFile);
      const commands = [
        ["arch", "projection", "status", "--json"],
        ["arch", "debt", "--json"],
        ["arch", "refactor", "recommendations", "--repo", ROOT, "--json"],
        ["arch", "codegraph", "ensure", "--repo", ROOT],
        ["arch", "codegraph", "configure", "--target", "codex", "--location", "global", "--repo", ROOT],
        ["arch", "module", "list", "--json"],
        ["arch", "module", "review-prompt", "capability.runtime-harness.architecture", "--json"],
      ];
      // No install state, then a recorded selection without the plugin.
      for (const [selection, repair] of [
        [null, "rh install"],
        [["product"], "rh install --plugins architecture,product"],
      ] as const) {
        if (selection) recordPluginSelection({ HOME: envRoot.home }, selection);
        for (const args of commands) {
          const name = args.slice(0, 3).join(" ");
          const res = spawnSync("bun", [CLI, ...args], {
            cwd: ROOT, encoding: "utf-8",
            env: { ...process.env, HOME: envRoot.home, PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}` },
          });
          expect(res.status, `${repair}: ${name}`).toBe(1);
          expect(res.stdout, name).toBe("");
          expect(res.stderr, name).toContain(`rh arch needs the architecture plugin: the architecture plugin is not selected; run: ${repair}\n`);
        }
      }
      expect(() => readFileSync(logFile, "utf-8")).toThrow();
    } finally {
      rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, 60000);
});
