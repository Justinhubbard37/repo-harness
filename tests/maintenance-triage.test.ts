import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "maintenance-triage.sh");

function git(repo: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

function entry(
  theme: string,
  trigger: string,
  { seen = "1×", enforcedBy = "judgment", promoted }: { seen?: string; enforcedBy?: string; promoted?: string } = {},
): string {
  return [
    "- Date: 2026-10-01",
    `- Mistake pattern: ${theme}`,
    "- Prevention rule: Keep the failure evidence.",
    `- Enforced by: ${enforcedBy}`,
    `- Triggered by correction: ${trigger}`,
    `- Seen: ${seen}`,
    ...(promoted ? [`- Promoted: ${promoted}`] : []),
    "",
  ].join("\n");
}

function ledgerRepo(seed: string): string {
  const repo = mkdtempSync(join(tmpdir(), "maintenance-triage-"));
  mkdirSync(join(repo, "tasks"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "triage@example.com"]);
  git(repo, ["config", "user.name", "triage"]);
  writeFileSync(join(repo, "tasks", "lessons.md"), `# Lessons\n\n${seed}`);
  git(repo, ["add", "tasks/lessons.md"]);
  git(repo, ["commit", "-qm", "docs(lessons): record three failures (#10)"]);
  return repo;
}

function consolidate(repo: string, body: string): void {
  writeFileSync(join(repo, "tasks", "lessons.md"), `# Lessons\n\n${body}`);
  git(repo, ["add", "tasks/lessons.md"]);
  git(repo, ["commit", "-qm", "refactor(lessons): consolidate the ledger (#20)"]);
}

function triage(repo: string, args: string[] = []) {
  return spawnSync("bash", [SCRIPT, ...args], { cwd: repo, encoding: "utf-8" });
}

describe("maintenance triage lesson evidence", () => {
  test("fails an entry whose only Triggered by correction is the consolidation PR", () => {
    const repo = ledgerRepo([
      entry("theme-a", "#10"),
      entry("theme-b", "#11"),
      entry("theme-c", "#12"),
    ].join("\n"));
    try {
      consolidate(repo, [entry("theme-a", "#20"), entry("theme-b", "#20")].join("\n"));
      const res = triage(repo, ["--json"]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as { evidence_errors: { theme: string }[] };
      expect(report.evidence_errors.map((item) => item.theme).sort()).toEqual(["theme-a", "theme-b"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("passes when the consolidating entry keeps the earlier references", () => {
    const repo = ledgerRepo([
      entry("theme-a", "#10"),
      entry("theme-b", "#11"),
      entry("theme-c", "#12"),
    ].join("\n"));
    try {
      consolidate(repo, [entry("theme-a", "#10, #20"), entry("theme-b", "#11, #20")].join("\n"));
      const res = triage(repo, ["--json"]);
      expect(res.status).toBe(0);
      expect((JSON.parse(res.stdout) as { evidence_errors: unknown[] }).evidence_errors).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("text mode names the failing entry and exits non-zero", () => {
    const repo = ledgerRepo([
      entry("theme-a", "#10"),
      entry("theme-b", "#11"),
    ].join("\n"));
    try {
      consolidate(repo, entry("theme-a", "#20"));
      const res = triage(repo);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("consolidation commit");
      expect(res.stdout).toContain("theme-a: #20");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("maintenance triage judgment themes", () => {
  test("lists the themes whose latest cumulative Seen is 3 or more and that judgment enforces", () => {
    const repo = ledgerRepo([
      entry("counted-by-seen", "#10", { seen: "4×", promoted: "#30" }),
      entry("below-three", "#11", { seen: "1×" }),
      entry("below-three", "#12", { seen: "2×" }),
      entry("migrated-to-check", "#13", { seen: "3×" }),
      entry("migrated-to-check", "#13, #14", { seen: "3×", enforcedBy: "tests/maintenance-triage.test.ts" }),
      entry("repeat-after-promotion", "#15", { seen: "3×", promoted: "#31" }),
      entry("repeat-after-promotion", "#16", { seen: "4×" }),
    ].join("\n"));
    try {
      const res = triage(repo, ["--json"]);
      expect(res.status).toBe(0);
      const report = JSON.parse(res.stdout) as { judgment: { key: string; seen: number; promoted: string | null }[] };
      expect(report.judgment.map(({ key, seen, promoted }) => ({ key, seen, promoted }))).toEqual([
        { key: "counted-by-seen", seen: 4, promoted: "#30" },
        { key: "repeat-after-promotion", seen: 4, promoted: "#31" },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("fails closed on a malformed Seen and does not compute the judgment themes", () => {
    const repo = ledgerRepo(entry("theme-a", "#10", { seen: "three" }));
    try {
      const res = triage(repo, ["--json"]);
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as { judgment: unknown; field_errors: { field: string; value: string }[] };
      expect(report.judgment).toBeNull();
      expect(report.field_errors.map(({ field, value }) => ({ field, value }))).toEqual([{ field: "Seen", value: "three" }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
