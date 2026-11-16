import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { buildProgram } from "../../src/cli/index";
import { checkSpan } from "../../scripts/check-cli-manifest";

type Manifest = { kind: string; protocol: number; commands: { path: string[]; plugin: string; options: { flags: string }[] }[] };

function leafPaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap(child => {
    const path = [...prefix, child.name()];
    return child.commands.length > 0 ? leafPaths(child, path) : [path.join(" ")];
  });
}

async function output(argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    await buildProgram().parseAsync(["bun", "rh", ...argv]);
  } finally {
    console.log = original;
  }
  return lines;
}

async function manifest(): Promise<Manifest> {
  return JSON.parse((await output(["commands", "--json"])).join("\n")) as Manifest;
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

  test("every printed path passes the manifest gate", async () => {
    const root = buildProgram();
    const printed = await output(["commands"]);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.filter(path => checkSpan(root, `rh ${path}`).length > 0)).toEqual([]);
  });

  test("the gate accepts Commander's implicit help command where the CLI prints help", () => {
    const root = buildProgram();
    expect(checkSpan(root, "rh review help")).toEqual([]);
    expect(checkSpan(root, "rh tools ensure help")).toEqual([]);
    expect(checkSpan(root, "rh help")).toEqual([]);
    expect(checkSpan(root, "rh review help round")).toEqual([]);
    expect(checkSpan(root, "rh help review")).toEqual([]);
    // `rh board` owns an action, so Commander adds no help command there and the CLI rejects the word.
    expect(checkSpan(root, "rh board help")).toContainEqual('unknown command "rh board help"');
  });

  test("the gate reports an implicit help target the CLI cannot resolve", () => {
    const root = buildProgram();
    expect(checkSpan(root, "rh help nosuch")).toContainEqual('unknown command "rh help nosuch"');
    expect(checkSpan(root, "rh review help nosuch")).toContainEqual('unknown command "rh review help nosuch"');
    // `rh module` registers no subcommand, so `help projection` is a target it cannot resolve.
    expect(checkSpan(root, "rh module help projection")).toContainEqual('unknown command "rh module help projection"');
    // An unknown flag stops the operand list before the target, so the CLI sees no target and exits 0.
    expect(checkSpan(root, "rh review help --json nosuch")).toEqual([]);
  });
});
