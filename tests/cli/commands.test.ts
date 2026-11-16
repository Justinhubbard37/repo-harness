import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { buildProgram } from "../../src/cli/index";

type Manifest = { kind: string; protocol: number; commands: { path: string[]; plugin: string; options: { flags: string }[] }[] };

function leafPaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap(child => {
    const path = [...prefix, child.name()];
    return child.commands.length > 0 ? leafPaths(child, path) : [path.join(" ")];
  });
}

async function manifest(): Promise<Manifest> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    await buildProgram().parseAsync(["bun", "rh", "commands", "--json"]);
  } finally {
    console.log = original;
  }
  return JSON.parse(lines.join("\n")) as Manifest;
}

describe("rh commands", () => {
  test("--json lists every leaf of the commander tree, hidden included", async () => {
    const document = await manifest();
    expect(document.kind).toBe("repo-harness.commands");
    expect(document.protocol).toBe(1);
    expect(document.commands.map(entry => entry.path.join(" "))).toEqual(leafPaths(buildProgram()).sort((a, b) => a.localeCompare(b)));
    expect(document.commands.some(entry => entry.path[0] === "__reconcile-installed-runtime")).toBe(true);
  });

  test("plugin is the recorded id, else the nearest ancestor's, else core", async () => {
    const plugins = new Map((await manifest()).commands.map(entry => [entry.path.join(" "), entry.plugin]));
    expect(plugins.get("module list")).toBe("architecture");
    expect(plugins.get("review round")).toBe("peer-runtime");
    expect(plugins.get("review publish")).toBe("core");
    expect(plugins.get("mcp serve")).toBe("mcp");
    expect(plugins.get("mcp access set")).toBe("core");
  });

  test("a leaf lists the options of its ancestors", async () => {
    const flags = (await manifest()).commands.find(entry => entry.path.join(" ") === "board parents")?.options.map(option => option.flags) ?? [];
    expect(flags).toContain("--json");
    expect(flags.some(flag => flag.startsWith("--parent"))).toBe(true);
  });
});
