import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  beginInstallHostTransaction,
  rollbackInstallHostTransaction,
  installProfileTransactionPaths,
} from "../../src/cli/installer/install-profile";
import { openHostConfigGate } from "../../src/effects/host-config/gate";
import { mutationPathSkillNames, type SkillSurfaceCatalog } from "../../src/core/skill-surface/catalog";

function withHome(run: (env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), "repo-harness-mutation-path-"));
  try {
    run({ ...process.env, HOME: home, BUN_INSTALL: join(home, ".bun") });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writePath(path: string, content = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A minimal, self-contained synthetic catalog carrying a brand-new package that no real installer code has ever heard of. */
function catalogWithSyntheticPackage(newName: string): SkillSurfaceCatalog {
  const router = {
    name: "repo-harness",
    kind: "router" as const,
    source: ".",
    provider: null,
    hosts: ["claude", "codex"] as const,
    owner: "core" as const,
    explicitOnly: false,
    discoverability: "always" as const,
    requires: [],
    mutatesRepoByDefault: false,
    summary: "root router",
    retirementCandidate: null,
  };
  const newFacade = {
    name: newName,
    kind: "facade" as const,
    source: `assets/skill-commands/${newName}`,
    provider: null,
    hosts: ["claude", "codex"] as const,
    owner: "product" as const,
    explicitOnly: false,
    discoverability: "profile-facade" as const,
    requires: [],
    mutatesRepoByDefault: false,
    summary: "a synthetic facade the real manifest has never declared",
    retirementCandidate: null,
  };
  return { packages: [router, newFacade] } as unknown as SkillSurfaceCatalog;
}

describe("mutation-path coverage: a synthetic new catalog package is picked up without code changes", () => {
  test("mutationPathSkillNames() includes the new package's name automatically", () => {
    const catalog = catalogWithSyntheticPackage("repo-harness-newthing");
    const { repoHarnessSkills } = mutationPathSkillNames(catalog);
    expect(repoHarnessSkills).toContain("repo-harness-newthing");
    expect(repoHarnessSkills).toContain("repo-harness");
  });

  test("gate preimages restore a catalog tree on both hosts without host snapshots", () => withHome(env => {
    const source = join(env.HOME!, 'source');
    writePath(join(source, 'SKILL.md'), '# original\n');
    const destinations = ['.codex', '.claude'].map(host => join(env.HOME!, host, 'skills', 'repo-harness-newthing'));
    const gate = openHostConfigGate({ env });
    const writes = destinations.map(path => ({ path, owner: 'product', entry: { type: 'directory' as const, source } }));
    gate.writePaths(writes);
    const transaction = beginInstallHostTransaction(installProfileTransactionPaths(env), env);
    expect(transaction.snapshots.some(snapshot => destinations.includes(snapshot.path))).toBe(false);
    writeFileSync(join(source, 'SKILL.md'), '# replacement\n');
    writeFileSync(join(source, 'NEW-FILE.md'), '# new\n');
    gate.writePaths(writes, { transaction: transaction.backup_root });
    rollbackInstallHostTransaction(transaction);
    for (const path of destinations) {
      expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('# original\n');
      expect(existsSync(join(path, 'NEW-FILE.md'))).toBe(false);
    }
  }));

  test("gate rollback removes a new catalog entry and keeps an unrecorded user tree", () => withHome(env => {
    const source = join(env.HOME!, 'source');
    writePath(join(source, 'SKILL.md'), '# managed\n');
    const path = join(env.HOME!, '.codex/skills/repo-harness-newthing');
    const gate = openHostConfigGate({ env });
    const transaction = beginInstallHostTransaction(installProfileTransactionPaths(env), env);
    gate.writePaths([{ path, owner: 'product', entry: { type: 'directory', source } }], { transaction: transaction.backup_root });
    rollbackInstallHostTransaction(transaction);
    expect(existsSync(path)).toBe(false);
    writePath(join(path, 'SKILL.md'), '# user\n');
    expect(() => gate.writePaths([{ path, owner: 'product', entry: { type: 'directory', source } }])).toThrow();
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('# user\n');
  }));
});
