import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

import { MANAGED_AGENTS, WRITABLE_AGENTS } from '../src/effects/terminal/task-role-profiles';
import { installProfileHostMutationPaths } from "../src/cli/installer/install-profile";

import { recordInstallOwnership } from "./helpers/install-ownership";
import { writeBunWrapper } from "./helpers/repo-fixture";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/install-agent-fleet.sh");
const FLEET_SOURCE_DIR = join(ROOT, "agents/fleet");
const GOLDEN_CODEX_DIR = join(ROOT, ".codex/agents");
const AGENTS = ["explorer", "deep-reasoner", "fast-worker", "deep-worker", "gatekeeper", "root-cause-prover", "harness-evaluator"];
const CODEX_EXPECTATIONS: Record<
  string,
  { model: string; effort: string; descriptionLabel: string; sourceDescription: string; sandboxMode: string }
> = {
  explorer: {
    model: "gpt-6-luna",
    effort: "high",
    descriptionLabel: "GPT-6 Luna at high reasoning",
    sourceDescription: "Sonnet at medium effort",
    sandboxMode: "read-only",
  },
  "deep-reasoner": {
    model: "gpt-6-astra",
    effort: "high",
    descriptionLabel: "GPT-6 Astra at high reasoning",
    sourceDescription: "Opus at xhigh effort",
    sandboxMode: "read-only",
  },
  "fast-worker": {
    model: "gpt-6.1-sol",
    effort: "medium",
    descriptionLabel: "GPT-6.1 Sol at medium reasoning",
    sourceDescription: "Sonnet at high effort",
    sandboxMode: "workspace-write",
  },
  "deep-worker": {
    model: "gpt-6.1-sol",
    effort: "high",
    descriptionLabel: "GPT-6.1 Sol at high reasoning",
    sourceDescription: "Opus at high effort",
    sandboxMode: "workspace-write",
  },
  gatekeeper: {
    model: "gpt-6-astra",
    effort: "medium",
    descriptionLabel: "GPT-6 Astra at medium reasoning",
    sourceDescription: "Opus at high effort",
    sandboxMode: "read-only",
  },
  "root-cause-prover": {
    model: "gpt-6-astra",
    effort: "high",
    descriptionLabel: "GPT-6 Astra at high reasoning",
    sourceDescription: "Opus at xhigh effort",
    sandboxMode: "workspace-write",
  },
  "harness-evaluator": {
    model: "gpt-6-astra",
    effort: "medium",
    descriptionLabel: "GPT-6 Astra at medium reasoning",
    sourceDescription: "Opus at high effort",
    sandboxMode: "workspace-write",
  },
};

// Canonical anti-extras clause (scripts/contract-run.ts EXECUTION_BOUNDARY, joined with
// "\n"). Hardcoded here the same way tests/workflow-contract.test.ts hardcodes the
// canonical first sentence: this is the literal text the installer must NOT embed into
// a generated persona. The clause has exactly one owner on the Codex native-child path,
// the SubagentStart task packet, which alone knows whether the child is contract-bound
// and writable.
const CANONICAL_BOUNDARY_TEXT = [
  "Execution boundary: implement exactly the Goal, In scope items, Allowed Paths, and Exit Criteria in this brief. Treat absent requirements as forbidden design space, not as permission to improve.",
  "",
  "Do not add optional features, alternate UX, extra integrations, migration paths, compatibility behavior, fallback behavior, telemetry, broad cleanup, refactors, new abstractions, extra docs, or polish unless that work is explicitly listed under In scope or required by Exit Criteria.",
  "",
  "If you discover useful additional work, record it under Out of scope / Future work in the notes or review artifact. Do not implement it. Do not end with unsolicited offers to do more work.",
  "",
  "If the requested outcome cannot be completed without expanding scope, fail closed: stop, name the missing decision, and cite the exact file/section that blocks execution.",
].join("\n");

function setupFakeHome(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}

let runtimeSequence = 0;

function prepareInstallerRuntime(home: string, sourceDir: string) {
  const packageRoot = join(dirname(home), `package-runtime-${runtimeSequence++}`);
  const runtimeScript = join(packageRoot, "scripts/install-agent-fleet.sh");
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(join(packageRoot, "agents"), { recursive: true });
  cpSync(SCRIPT, runtimeScript);
  symlinkSync(join(ROOT, "src"), join(packageRoot, "src"), "dir");
  chmodSync(runtimeScript, 0o755);
  cpSync(sourceDir, join(packageRoot, "agents/fleet"), { recursive: true });
  return { packageRoot, runtimeScript };
}

function runInstaller(
  home: string,
  sourceDir: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  const runtime = prepareInstallerRuntime(home, sourceDir);
  return spawnSync("bash", [runtime.runtimeScript, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      ...extraEnv,
    },
  });
}

describe("install-agent-fleet", () => {
  test("upgrades receipt-owned fleet files and preserves subsequent user edits", () => {
    const { root, home } = setupFakeHome("fleet-owned-upgrade");
    const env = { ...process.env, HOME: home };
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const paths = AGENTS.flatMap(agent => [join(home, ".claude/agents", `${agent}.md`), join(home, ".codex/agents", `${agent}.toml`)]);
      recordInstallOwnership(paths, env);
      for (const path of paths) expect(installProfileHostMutationPaths(env)).toContain(path);
      const next = join(root, "next");
      cpSync(FLEET_SOURCE_DIR, next, { recursive: true });
      for (const agent of AGENTS) {
        const file = join(next, `${agent}.md`);
        writeFileSync(file, readFileSync(file, "utf8") + "\nUpdated role instruction.\n");
      }
      const result = runInstaller(home, next);
      expect(result.status).toBe(0);
      recordInstallOwnership(paths, env);
      for (const host of [".claude", ".codex"]) {
        const file = join(home, host, "agents", `deep-worker.${host === ".claude" ? "md" : "toml"}`);
        expect(readFileSync(file, "utf8")).toContain("Updated role instruction.");
        writeFileSync(file, readFileSync(file, "utf8") + "\n# User edit\n");
      }
      const blocked = runInstaller(home, FLEET_SOURCE_DIR);
      expect(blocked.status).toBe(1);
      expect(blocked.stdout).toContain("deep-worker.md: drift");
      expect(blocked.stdout).toContain("deep-worker.toml: drift");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("fresh install writes claude .md byte-identical to source and codex .toml byte-identical to golden", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-fresh");
    try {
      const res = runInstaller(home, FLEET_SOURCE_DIR);
      expect(res.status).toBe(0);

      for (const agent of AGENTS) {
        expect(res.stdout).toContain(`[fleet] claude/${agent}.md: installed`);
        expect(res.stdout).toContain(`[fleet] codex/${agent}.toml: installed`);

        const installedClaude = readFileSync(join(home, ".claude/agents", `${agent}.md`), "utf-8");
        const sourceClaude = readFileSync(join(FLEET_SOURCE_DIR, `${agent}.md`), "utf-8");
        expect(installedClaude).toBe(sourceClaude);

        const installedCodex = readFileSync(join(home, ".codex/agents", `${agent}.toml`), "utf-8");
        const golden = readFileSync(join(GOLDEN_CODEX_DIR, `${agent}.toml`), "utf-8");
        const expected = CODEX_EXPECTATIONS[agent];
        expect(installedCodex).toBe(golden);
        expect(installedCodex).toContain(`model = "${expected.model}"`);
        expect(installedCodex).toContain(`model_reasoning_effort = "${expected.effort}"`);
        expect(installedCodex).toContain(expected.descriptionLabel);
        expect(installedCodex).toContain(`sandbox_mode = "${expected.sandboxMode}"`);
        expect(installedCodex).not.toContain(expected.sourceDescription);
        expect(installedCodex).not.toMatch(/\b(?:fable|opus|sonnet|haiku)\b/i);
      }

      // The orchestrator is a seat (`rh seats argv orchestrator`), not a fleet role.
      expect(res.stdout).not.toContain("orchestrator");
      expect(existsSync(join(home, ".claude/agents/orchestrator.md"))).toBe(false);
      expect(existsSync(join(home, ".codex/agents/orchestrator.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("idempotent re-run reports up-to-date for all 14 files", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-idempotent");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const second = runInstaller(home, FLEET_SOURCE_DIR);
      expect(second.status).toBe(0);
      for (const agent of AGENTS) {
        expect(second.stdout).toContain(`[fleet] claude/${agent}.md: up-to-date`);
        expect(second.stdout).toContain(`[fleet] codex/${agent}.toml: up-to-date`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("local modification to an installed target is preserved and reported as drift", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-drift");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const target = join(home, ".codex/agents/gatekeeper.toml");
      const locallyEdited = [
        'developer_instructions = """escaped delimiter: \\"""',
        'name = "fast-worker"',
        'still part of developer instructions"""',
        'name = "fast-worker # local"',
        'description = "identity-correct local drift"',
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "xhigh"',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n");
      writeFileSync(target, locallyEdited);

      const second = runInstaller(home, FLEET_SOURCE_DIR);
      expect(second.status).not.toBe(0);
      expect(second.stdout).toContain("[fleet] codex/gatekeeper.toml: drift");
      expect(readFileSync(target, "utf-8")).toBe(locallyEdited);

      const claudeTarget = join(home, ".claude/agents/gatekeeper.md");
      const quotedIdentityEdit = `${readFileSync(claudeTarget, "utf-8")
        .replace("name: gatekeeper", 'name: "gatekeeper" # local style')
        .replace("\n---\n", "\nmetadata:\n  name: fast-worker\n---\n")}\n# preserve-me\n`;
      writeFileSync(claudeTarget, quotedIdentityEdit);
      const third = runInstaller(home, FLEET_SOURCE_DIR);
      expect(third.status).not.toBe(0);
      expect(third.stdout).toContain("[fleet] claude/gatekeeper.md: drift");
      expect(readFileSync(claudeTarget, "utf-8")).toBe(quotedIdentityEdit);

      const ambiguousYamlIdentityEdit = quotedIdentityEdit.replace('name: "gatekeeper" # local style', "name: null");
      writeFileSync(claudeTarget, ambiguousYamlIdentityEdit);
      const fourth = runInstaller(home, FLEET_SOURCE_DIR);
      expect(fourth.status).not.toBe(0);
      expect(fourth.stdout).toContain("[fleet] claude/gatekeeper.md: drift");
      expect(readFileSync(claudeTarget, "utf-8")).toBe(ambiguousYamlIdentityEdit);

      const duplicateYamlIdentityEdit = quotedIdentityEdit.replace(
        'name: "gatekeeper" # local style',
        "name: gatekeeper\nname: fast-worker",
      );
      writeFileSync(claudeTarget, duplicateYamlIdentityEdit);
      const fifth = runInstaller(home, FLEET_SOURCE_DIR);
      expect(fifth.status).not.toBe(0);
      expect(fifth.stdout).toContain("[fleet] claude/gatekeeper.md: drift");
      expect(readFileSync(claudeTarget, "utf-8")).toBe(duplicateYamlIdentityEdit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an explicitly accepted user-managed fleet remains idempotent until an accepted file changes", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-user-managed");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const claudeTarget = join(home, ".claude/agents/deep-reasoner.md");
      const codexTarget = join(home, ".codex/agents/explorer.toml");
      const customClaude = readFileSync(claudeTarget, "utf-8")
        .replaceAll("Opus at xhigh effort", "Opus at max effort")
        .replace("effort: xhigh", "effort: max");
      const customCodex = readFileSync(codexTarget, "utf-8")
        .replace('model = "gpt-6-luna"', 'model = "gpt-6.1-sol"');
      writeFileSync(claudeTarget, customClaude);
      writeFileSync(codexTarget, customCodex);

      const accepted = runInstaller(home, FLEET_SOURCE_DIR, ["--accept-user-managed"]);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain("[fleet] user-managed receipt: accepted 2 files");
      expect(readFileSync(claudeTarget, "utf-8")).toBe(customClaude);
      expect(readFileSync(codexTarget, "utf-8")).toBe(customCodex);

      const receiptPath = join(home, ".repo-harness/agent-fleet-user-managed.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as {
        protocol: number;
        authority: string;
        files: Array<{ path: string; sha256: string }>;
      };
      expect(receipt.protocol).toBe(1);
      expect(receipt.authority).toBe("user-managed-agent-fleet");
      expect(receipt.files.map((entry) => entry.path).sort()).toEqual([claudeTarget, codexTarget].sort());
      expect(receipt.files.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);

      const repeated = runInstaller(home, FLEET_SOURCE_DIR);
      expect(repeated.status).toBe(0);
      expect(repeated.stdout).toContain("[fleet] claude/deep-reasoner.md: user-managed");
      expect(repeated.stdout).toContain("[fleet] codex/explorer.toml: user-managed");
      expect(readFileSync(claudeTarget, "utf-8")).toBe(customClaude);
      expect(readFileSync(codexTarget, "utf-8")).toBe(customCodex);

      const changedAfterAcceptance = `${customCodex}# changed after acceptance\n`;
      writeFileSync(codexTarget, changedAfterAcceptance);
      const staleReceipt = runInstaller(home, FLEET_SOURCE_DIR);
      expect(staleReceipt.status).not.toBe(0);
      expect(staleReceipt.stdout).toContain("[fleet] codex/explorer.toml: drift");
      expect(readFileSync(codexTarget, "utf-8")).toBe(changedAfterAcceptance);

      const forced = runInstaller(home, FLEET_SOURCE_DIR, ["--force"]);
      expect(forced.status).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
      expect(readFileSync(codexTarget, "utf-8")).toBe(
        readFileSync(join(GOLDEN_CODEX_DIR, "explorer.toml"), "utf-8"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--accept-user-managed rejects malformed or role-mismatched files without writing a receipt", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-user-managed-invalid");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const target = join(home, ".claude/agents/gatekeeper.md");
      writeFileSync(
        target,
        readFileSync(target, "utf-8").replace("name: gatekeeper", "name: fast-worker"),
      );

      const accepted = runInstaller(home, FLEET_SOURCE_DIR, ["--accept-user-managed"]);
      expect(accepted.status).not.toBe(0);
      expect(accepted.stdout).toContain("[fleet] claude/gatekeeper.md: user-managed-invalid");
      expect(existsSync(join(home, ".repo-harness/agent-fleet-user-managed.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test.each([
    ["claude", "md", "none"], ["codex", "toml", "none"],
    ["claude", "md", "stale"], ["codex", "toml", "stale"],
  ] as const)("--force saves %s/%s user bytes and mode (prior ownership: %s) and prints a working restore command", (host, ext, owned) => {
    const { root, home } = setupFakeHome("install-agent-fleet-user's home");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const file = `gatekeeper.${ext}`;
      const target = join(home, `.${host}/agents`, file);
      if (owned === "stale") recordInstallOwnership([target], { ...process.env, HOME: home });
      const original = Buffer.from([0x75, 0x73, 0x65, 0x72, 0x00, 0xff, 0x0a]);
      writeFileSync(target, original);
      chmodSync(target, 0o640);

      const forced = runInstaller(home, FLEET_SOURCE_DIR, ["--force"]);
      expect(forced.status).toBe(0);
      const line = forced.stdout.split("\n").find(line => line.startsWith(`[fleet] ${host}/${file}:`));
      const replacement = /: replaced \(backup: (.*); restore: (.*)\)$/.exec(line ?? "");
      expect(replacement).not.toBeNull();
      const [, backup, restore] = replacement!;
      const backupDir = join(home, ".repo-harness/replaced-agents");
      expect(readdirSync(backupDir)).toEqual([backup.slice(backupDir.length + 1)]);
      expect(backup).toMatch(new RegExp(`${host}-${file}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-\\d+\\.bak$`));
      expect(readFileSync(backup)).toEqual(original);
      expect(statSync(backup).mode & 0o777).toBe(0o640);
      expect(statSync(backupDir).mode & 0o777).toBe(0o700);
      const generated = join(host === "claude" ? FLEET_SOURCE_DIR : GOLDEN_CODEX_DIR, file);
      expect(readFileSync(target)).toEqual(readFileSync(generated));
      expect(spawnSync("sh", ["-c", restore], { cwd: root, env: { ...process.env, HOME: home } }).status).toBe(0);
      expect(readFileSync(target)).toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test.each([
    ["read-only state directory", "both"], ["unreadable sources", "both"],
    ["mixed replacements", "claude"], ["mixed replacements", "codex"],
  ])("--force keeps the accepted receipt with %s (failed host: %s)", (failure, failedHost) => {
    const { root, home } = setupFakeHome("install-agent-fleet-backup-failure");
    const stateDir = join(home, ".repo-harness");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR).status).toBe(0);
      const targets = [["claude", "md"], ["codex", "toml"]].map(([host, ext]) => {
        const file = `explorer.${ext}`;
        const path = join(home, `.${host}/agents`, file);
        const generated = readFileSync(path, "utf8");
        const custom = `${generated}\n# user agent\n`;
        writeFileSync(path, custom);
        return { host, file, path, generated, custom, blocked: failedHost === "both" || failedHost === host };
      });
      expect(runInstaller(home, FLEET_SOURCE_DIR, ["--accept-user-managed"]).status).toBe(0);
      const receiptPath = join(stateDir, "agent-fleet-user-managed.json");
      const receipt = readFileSync(receiptPath);
      if (failure === "read-only state directory") chmodSync(stateDir, 0o500);
      else for (const target of targets) if (target.blocked) chmodSync(target.path, 0o200);

      const failed = runInstaller(home, FLEET_SOURCE_DIR, ["--force"]);
      expect(failed.status).toBe(1);
      for (const target of targets) {
        expect(failed.stdout).toContain(`[fleet] ${target.host}/${target.file}: ${target.blocked ? "backup-failed" : "replaced (backup:"}`);
        if (target.blocked && failure !== "read-only state directory") chmodSync(target.path, 0o600);
        expect(readFileSync(target.path, "utf8")).toBe(target.blocked ? target.custom : target.generated);
      }
      expect(readFileSync(receiptPath)).toEqual(receipt);
      const backupDir = join(stateDir, "replaced-agents");
      if (failedHost === "both") expect(existsSync(backupDir)).toBe(false);
      else expect(readdirSync(backupDir)).toHaveLength(1);

      chmodSync(stateDir, 0o700);
      const normal = runInstaller(home, FLEET_SOURCE_DIR);
      expect(normal.status).toBe(0);
      for (const target of targets) {
        expect(normal.stdout).toContain(`[fleet] ${target.host}/${target.file}: ${target.blocked ? "user-managed" : "up-to-date"}`);
      }
      expect(readFileSync(receiptPath)).toEqual(receipt);
      expect(runInstaller(home, FLEET_SOURCE_DIR, ["--force"]).status).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      chmodSync(stateDir, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--force makes no backups for absent, identical or current rh-owned targets", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-force-no-backup");
    const backupDir = join(home, ".repo-harness/replaced-agents");
    try {
      expect(runInstaller(home, FLEET_SOURCE_DIR, ["--force"]).status).toBe(0);
      expect(existsSync(backupDir)).toBe(false);
      expect(runInstaller(home, FLEET_SOURCE_DIR, ["--force"]).stdout).toContain("explorer.md: up-to-date");
      expect(existsSync(backupDir)).toBe(false);
      const targets = [join(home, ".claude/agents/explorer.md"), join(home, ".codex/agents/explorer.toml")];
      recordInstallOwnership(targets, { ...process.env, HOME: home });
      const next = join(root, "next");
      cpSync(FLEET_SOURCE_DIR, next, { recursive: true });
      const source = join(next, "explorer.md");
      writeFileSync(source, readFileSync(source, "utf8") + "\nUpdated role instruction.\n");
      const upgraded = runInstaller(home, next, ["--force"]);
      expect(upgraded.status).toBe(0);
      expect(upgraded.stdout).toContain("[fleet] claude/explorer.md: installed");
      expect(upgraded.stdout).toContain("[fleet] codex/explorer.toml: installed");
      for (const target of targets) expect(readFileSync(target, "utf8")).toContain("Updated role instruction.");
      expect(existsSync(backupDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("invalid frontmatter fails the whole source preflight before any target mutation", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-invalid");
    const badSourceDir = join(root, "bad-source");
    try {
      mkdirSync(badSourceDir, { recursive: true });
      for (const agent of AGENTS) {
        cpSync(join(FLEET_SOURCE_DIR, `${agent}.md`), join(badSourceDir, `${agent}.md`));
      }
      const corrupted = readFileSync(join(badSourceDir, "fast-worker.md"), "utf-8").replace("effort: high", "effort: min");
      writeFileSync(join(badSourceDir, "fast-worker.md"), corrupted);

      const res = runInstaller(home, badSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/fast-worker.md: source-invalid");
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: source-invalid");
      expect(existsSync(join(home, ".claude/agents/fast-worker.md"))).toBe(false);
      expect(existsSync(join(home, ".codex/agents/fast-worker.toml"))).toBe(false);
      expect(existsSync(join(home, ".claude/agents/deep-reasoner.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a missing or unparseable source role identity fails the installer", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-missing-role-identity");
    const badSourceDir = join(root, "bad-source");
    try {
      mkdirSync(badSourceDir, { recursive: true });
      for (const agent of AGENTS) {
        cpSync(join(FLEET_SOURCE_DIR, `${agent}.md`), join(badSourceDir, `${agent}.md`));
      }
      writeFileSync(
        join(badSourceDir, "fast-worker.md"),
        [
          "---",
          "- metadata:",
          "    name: fast-worker",
          "    description: nested identity is not root role metadata",
          "    model: sonnet",
          "    effort: max",
          "---",
          "nested role fixture",
          "",
        ].join("\n"),
      );

      const res = runInstaller(home, badSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/fast-worker.md: source-invalid");
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: source-invalid");
      expect(existsSync(join(home, ".codex/agents/fast-worker.toml"))).toBe(false);
      expect(existsSync(join(home, ".codex/agents/deep-reasoner.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a frontmatter name that does not match its source role fails closed", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-role-name-mismatch");
    const badSourceDir = join(root, "bad-source");
    try {
      mkdirSync(badSourceDir, { recursive: true });
      for (const agent of AGENTS) {
        cpSync(join(FLEET_SOURCE_DIR, `${agent}.md`), join(badSourceDir, `${agent}.md`));
      }
      const corrupted = readFileSync(join(badSourceDir, "gatekeeper.md"), "utf-8")
        .replace("name: gatekeeper", "name: fast-worker")
        .replace("description:", "removed_description:");
      writeFileSync(join(badSourceDir, "gatekeeper.md"), corrupted);
      const installedClaudeDir = join(home, ".claude/agents");
      const installedCodexDir = join(home, ".codex/agents");
      mkdirSync(installedClaudeDir, { recursive: true });
      mkdirSync(installedCodexDir, { recursive: true });
      writeFileSync(join(installedClaudeDir, "gatekeeper.md"), corrupted);
      writeFileSync(
        join(installedCodexDir, "gatekeeper.toml"),
        '"name" = "fast-worker"\nsandbox_mode = "workspace-write"\n',
      );

      const res = runInstaller(home, badSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/gatekeeper.md: source-invalid");
      expect(res.stdout).toContain("[fleet] codex/gatekeeper.toml: source-invalid");
      expect(readFileSync(join(home, ".claude/agents/gatekeeper.md"), "utf-8")).toBe(corrupted);
      expect(readFileSync(join(home, ".codex/agents/gatekeeper.toml"), "utf-8")).toContain('"name" = "fast-worker"');
      expect(existsSync(join(home, ".codex/agents/fast-worker.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a corrected source refuses stale installed targets with mismatched role identities", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-stale-role-identity");
    try {
      const installedClaudeDir = join(home, ".claude/agents");
      const installedCodexDir = join(home, ".codex/agents");
      mkdirSync(installedClaudeDir, { recursive: true });
      mkdirSync(installedCodexDir, { recursive: true });
      const mismatchedClaude = readFileSync(join(FLEET_SOURCE_DIR, "gatekeeper.md"), "utf-8")
        .replace(/^---\n([\s\S]*?)\n---/, (_match, frontmatter) => {
          const indented = String(frontmatter)
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n");
          return `---\n${indented}\n---`;
        })
        .replace("  name: gatekeeper", "  name: fast-worker");
      writeFileSync(join(installedClaudeDir, "gatekeeper.md"), mismatchedClaude);
      writeFileSync(
        join(installedCodexDir, "gatekeeper.toml"),
        "  'name' = \"fast-worker\"\nsandbox_mode = \"workspace-write\"\n",
      );

      const res = runInstaller(home, FLEET_SOURCE_DIR);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/gatekeeper.md: drift");
      expect(res.stdout).toContain("[fleet] codex/gatekeeper.toml: drift");
      expect(readFileSync(join(installedClaudeDir, "gatekeeper.md"), "utf-8")).toBe(mismatchedClaude);
      expect(readFileSync(join(installedCodexDir, "gatekeeper.toml"), "utf-8")).toContain('"fast-worker"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an invalid source leaves a stale installed target untouched", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-stale-role-invalid-source");
    const badSourceDir = join(root, "bad-source");
    try {
      mkdirSync(badSourceDir, { recursive: true });
      for (const agent of AGENTS) {
        cpSync(join(FLEET_SOURCE_DIR, `${agent}.md`), join(badSourceDir, `${agent}.md`));
      }
      writeFileSync(
        join(badSourceDir, "gatekeeper.md"),
        readFileSync(join(badSourceDir, "gatekeeper.md"), "utf-8").replace("effort: high", "effort: min"),
      );
      const installedCodexDir = join(home, ".codex/agents");
      mkdirSync(installedCodexDir, { recursive: true });
      writeFileSync(
        join(installedCodexDir, "gatekeeper.toml"),
        'name = "fast-worker"\nsandbox_mode = "workspace-write"\n',
      );

      const res = runInstaller(home, badSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] codex/gatekeeper.toml: source-invalid");
      expect(readFileSync(join(installedCodexDir, "gatekeeper.toml"), "utf-8")).toContain('name = "fast-worker"');
      expect(existsSync(join(home, ".codex/agents/fast-worker.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a provider-specific description that disagrees with the model mapping fails closed", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-description-mismatch");
    const badSourceDir = join(root, "bad-source");
    try {
      mkdirSync(badSourceDir, { recursive: true });
      for (const agent of AGENTS) {
        cpSync(join(FLEET_SOURCE_DIR, `${agent}.md`), join(badSourceDir, `${agent}.md`));
      }
      const mismatched = readFileSync(join(badSourceDir, "fast-worker.md"), "utf-8").replace(
        "Sonnet at high effort",
        "an unspecified model",
      );
      writeFileSync(join(badSourceDir, "fast-worker.md"), mismatched);

      const res = runInstaller(home, badSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/fast-worker.md: source-invalid");
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: source-invalid");
      expect(existsSync(join(home, ".codex/agents/fast-worker.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("every managed role projects to both hosts", () => {
    expect(MANAGED_AGENTS).toEqual(AGENTS);
  });

  test("a missing packaged source fails the whole preflight before any target mutation", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-partial-source");
    const partialSourceDir = join(root, "partial-source");
    try {
      mkdirSync(partialSourceDir, { recursive: true });
      cpSync(join(FLEET_SOURCE_DIR, "explorer.md"), join(partialSourceDir, "explorer.md"));
      cpSync(join(FLEET_SOURCE_DIR, "deep-reasoner.md"), join(partialSourceDir, "deep-reasoner.md"));
      cpSync(join(FLEET_SOURCE_DIR, "gatekeeper.md"), join(partialSourceDir, "gatekeeper.md"));
      // fast-worker.md deliberately absent from partialSourceDir.

      const res = runInstaller(home, partialSourceDir);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/fast-worker.md: source-missing");
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: source-missing");
      expect(existsSync(join(home, ".claude/agents/fast-worker.md"))).toBe(false);
      expect(existsSync(join(home, ".claude/agents/deep-reasoner.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a decoy REPO_HARNESS_HELPER_SOURCE_PATH pointing at a different real helper still fails closed on a bad packaged fixture", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-decoy-helper-source-path");
    const partialSourceDir = join(root, "partial-source");
    try {
      mkdirSync(partialSourceDir, { recursive: true });
      cpSync(join(FLEET_SOURCE_DIR, "explorer.md"), join(partialSourceDir, "explorer.md"));
      cpSync(join(FLEET_SOURCE_DIR, "deep-reasoner.md"), join(partialSourceDir, "deep-reasoner.md"));
      cpSync(join(FLEET_SOURCE_DIR, "gatekeeper.md"), join(partialSourceDir, "gatekeeper.md"));
      // fast-worker.md deliberately absent from partialSourceDir, matching the
      // "missing packaged source" fixture shape above.

      // Simulates the real leak: rh run verify-sprint exports its own
      // resolved helper path (a different, real, unrelated packaged helper) into
      // the environment; a nested bun test child then inherits it verbatim. The
      // installer must reject this decoy (its basename does not match the
      // runtime script's own $0) and keep resolving package_root from $0.
      const decoyHelperSourcePath = join(ROOT, "scripts/verify-sprint.sh");
      expect(existsSync(decoyHelperSourcePath)).toBe(true);

      const res = runInstaller(home, partialSourceDir, [], {
        REPO_HARNESS_HELPER_SOURCE_PATH: decoyHelperSourcePath,
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain("[fleet] claude/fast-worker.md: source-missing");
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: source-missing");
      expect(existsSync(join(home, ".claude/agents/fast-worker.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("total failure (no source, no pre-existing targets) exits non-zero", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-total-failure");
    const emptySourceDir = join(root, "empty-source");
    try {
      mkdirSync(emptySourceDir, { recursive: true });
      const res = runInstaller(home, emptySourceDir);
      expect(res.status).not.toBe(0);
      for (const agent of AGENTS) {
        expect(res.stdout).toContain(`[fleet] claude/${agent}.md: source-missing`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("missing packaged source leaves existing targets untouched across retries", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-persistent-remediation-failure");
    const partialSourceDir = join(root, "partial-source");
    try {
      mkdirSync(partialSourceDir, { recursive: true });
      cpSync(join(FLEET_SOURCE_DIR, "explorer.md"), join(partialSourceDir, "explorer.md"));
      cpSync(join(FLEET_SOURCE_DIR, "deep-reasoner.md"), join(partialSourceDir, "deep-reasoner.md"));
      cpSync(join(FLEET_SOURCE_DIR, "fast-worker.md"), join(partialSourceDir, "fast-worker.md"));
      const installedCodexDir = join(home, ".codex/agents");
      mkdirSync(installedCodexDir, { recursive: true });
      writeFileSync(
        join(installedCodexDir, "gatekeeper.toml"),
        'name = "fast-worker"\nsandbox_mode = "workspace-write"\n',
      );

      const first = runInstaller(home, partialSourceDir);
      expect(first.status).not.toBe(0);
      expect(first.stdout).toContain("[fleet] codex/gatekeeper.toml: source-missing");
      expect(readFileSync(join(installedCodexDir, "gatekeeper.toml"), "utf-8")).toContain('name = "fast-worker"');

      const second = runInstaller(home, partialSourceDir);
      expect(second.status).not.toBe(0);
      expect(second.stdout).toContain("[fleet] codex/gatekeeper.toml: source-missing");
      expect(readFileSync(join(installedCodexDir, "gatekeeper.toml"), "utf-8")).toContain('name = "fast-worker"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("--help exits zero and does not create any HOME state", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-help");
    try {
      const res = runInstaller(home, FLEET_SOURCE_DIR, ["--help"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Usage:");
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(home, ".codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("the installer declares Bun as its only semantic parser runtime", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).toContain("install-agent-fleet.sh requires bun");
    expect(source).toContain('MIN_BUN_VERSION="1.4.0"');
    expect(source).toContain("Bun.TOML.parse(");
    expect(source).not.toContain("install-agent-fleet.sh requires node or bun");
    expect(source).toContain('AGENT_FLEET_SOURCE_DIR="$package_root/agents/fleet"');
    expect(source).not.toContain("REPO_HARNESS_FLEET_SOURCE_DIR");
    expect(source).not.toContain('spawnSync("curl"');
    expect(source).toContain('src/effects/terminal/task-role-profiles.ts');
    expect([...WRITABLE_AGENTS]).toEqual(['fast-worker','deep-worker','root-cause-prover','harness-evaluator']);
    expect(source).toContain("if (WRITABLE_AGENTS.has(agent))");
  }, 30_000);

  test("an unsupported Bun version fails before creating HOME state", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-old-bun");
    const fakeBin = join(root, "bin");
    const fakeBun = join(fakeBin, "bun");
    try {
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        fakeBun,
        ['#!/bin/sh', 'if [ "$1" = "--version" ]; then', "  echo 1.3.14", "  exit 0", "fi", "exit 99", ""].join("\n"),
      );
      chmodSync(fakeBun, 0o755);
      const res = spawnSync("bash", [SCRIPT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          REPO_HARNESS_BUN_BIN: "",
        },
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("requires Bun >= 1.4.0 (found: 1.3.14)");
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(home, ".codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an invalid explicit Bun fails closed despite a supported PATH Bun", () => {
    const { root, home } = setupFakeHome("fleet-explicit-bun-invalid");
    try {
      const supportedBin = join(root, "supported-bin");
      mkdirSync(supportedBin);
      writeBunWrapper(join(supportedBin, "bun"));
      const result = runInstaller(home, FLEET_SOURCE_DIR, [], {
        REPO_HARNESS_BUN_BIN: join(root, "missing-runtime"),
        PATH: `${supportedBin}:${process.env.PATH}`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("requires bun");
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(home, ".codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a supported HOME Bun wins when PATH resolves an unsupported Bun", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-home-bun-fallback");
    const fakeBin = join(root, "bin");
    const oldBun = join(fakeBin, "bun");
    const homeBun = join(home, ".bun/bin/bun");
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(join(home, ".bun/bin"), { recursive: true });
      writeFileSync(
        oldBun,
        ['#!/bin/sh', 'if [ "$1" = "--version" ]; then', "  echo 1.3.14", "  exit 0", "fi", "exit 99", ""].join("\n"),
      );
      writeFileSync(
        homeBun,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  echo 1.4.0",
          "  exit 0",
          "fi",
          `exec ${JSON.stringify(process.execPath)} "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(oldBun, 0o755);
      chmodSync(homeBun, 0o755);
      const res = spawnSync("bash", [SCRIPT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          REPO_HARNESS_BUN_BIN: "",
        },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[fleet] codex/fast-worker.toml: installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a handed-off Bun below the version floor fails closed instead of falling back to PATH discovery", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-handoff-below-floor");
    const fakeBin = join(root, "bin");
    const handoffBun = join(root, "handoff", "bun");
    const homeBun = join(home, ".bun/bin/bun");
    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(dirname(handoffBun), { recursive: true });
      mkdirSync(join(home, ".bun/bin"), { recursive: true });
      // The handed-off Bun (what a caller like `global-runtime.ts` already
      // validated) is below the version floor.
      writeFileSync(
        handoffBun,
        ['#!/bin/sh', 'if [ "$1" = "--version" ]; then', "  echo 1.3.14", "  exit 0", "fi", "exit 99", ""].join("\n"),
      );
      // A supported Bun sits at the HOME fallback location the pre-fix
      // discovery loop would have found. The fail-closed handoff must never
      // reach it: a caller that already validated a Bun gets that Bun
      // exclusively, not a silent substitute.
      writeFileSync(
        homeBun,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  echo 1.4.0",
          "  exit 0",
          "fi",
          `exec ${JSON.stringify(process.execPath)} "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(handoffBun, 0o755);
      chmodSync(homeBun, 0o755);
      const res = spawnSync("bash", [SCRIPT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          REPO_HARNESS_BUN_BIN: handoffBun,
        },
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("requires Bun >= 1.4.0 (found: 1.3.14)");
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(home, ".codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("generated developer_instructions carries the role body only, never the EXECUTION_BOUNDARY clause", () => {
    const { root, home } = setupFakeHome("install-agent-fleet-boundary");
    try {
      // The installer no longer owns the clause at all: neither its source nor any
      // generated persona may carry a paragraph of it.
      const installerSource = readFileSync(SCRIPT, "utf-8");
      for (const paragraph of CANONICAL_BOUNDARY_TEXT.split("\n\n")) {
        expect(installerSource).not.toContain(paragraph);
      }

      const res = runInstaller(home, FLEET_SOURCE_DIR);
      expect(res.status).toBe(0);
      for (const agent of AGENTS) {
        const toml = readFileSync(join(home, ".codex/agents", `${agent}.toml`), "utf-8");
        for (const paragraph of CANONICAL_BOUNDARY_TEXT.split("\n\n")) {
          expect(toml).not.toContain(paragraph);
        }
        // The persona body itself is still projected: developer_instructions ends
        // with the source body's final line, not with an appended boundary block.
        const sourceBody = readFileSync(join(FLEET_SOURCE_DIR, `${agent}.md`), "utf-8").trimEnd();
        const lastBodyLine = sourceBody.slice(sourceBody.lastIndexOf("\n") + 1);
        expect(toml).toContain(`${lastBodyLine}'''`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
