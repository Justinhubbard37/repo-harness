#!/usr/bin/env bun
/**
 * Gate: every inline-code `rh ...` span in the tracked skills and root
 * documents names a command and options that the commander tree registers.
 * The tree comes from buildProgram(), so no second command list exists.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Command, Option } from "commander";
import { allowsUnknownOptions, effectiveOptions, implicitHelpCommand } from "../src/cli/commands/commands";
import { archctxRefusal } from "../src/core/architecture/projection";
import { buildProgram } from "../src/cli/index";

const SCANNED = [
  /^assets\/skills\/.+\.md$/,
  /^assets\/skill-commands\/.+\.md$/,
  /^assets\/reference-configs\/.+\.md$/,
  /^references\/.+\.md$/,
  /^README[^/]*\.md$/,
  /^SKILL\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
];
const PATH_END = /[<[|$…]/;
const FLAG = /^[[(]*(--?[A-Za-z][\w-]*)/;

function findChild(command: Command, name: string): Command | undefined {
  return command.commands.find(child => child.name() === name || child.aliases().includes(name));
}

/** The flag one span token names, or undefined when the token is not a flag. */
function flagOf(token: string): string | undefined {
  return FLAG.exec(token)?.[1];
}

/** A declared option takes the next token as its value unless the value is inline (`--flag=value`). */
function takesValue(option: Option | undefined, token: string): boolean {
  return option !== undefined && (option.required || option.optional) && !token.includes("=");
}

/** The option a flag token names, in the chain or in any command below the last chain command (Commander passes an unmatched option down to the subcommand). */
function findOption(chain: readonly Command[], flag: string): Option | undefined {
  const matches = (option: Option) => option.long === flag || option.short === flag;
  const own = effectiveOptions(chain).find(matches);
  if (own) return own;
  const search = (command: Command): Option | undefined =>
    command.options.find(matches) ?? command.commands.map(search).find(found => found !== undefined);
  return search(chain[chain.length - 1]);
}

/**
 * The target an implicit help command reads: the first operand of this command. Commander collects the
 * operands with the options the chain declares and stops the list at a flag it does not know, so an
 * unknown flag before the target leaves the command no target, and no target is no error.
 */
function helpTarget(chain: readonly Command[], tokens: readonly string[], start: number): string | undefined {
  const declared = effectiveOptions(chain);
  let optionsEnded = false;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    const flag = optionsEnded ? undefined : flagOf(token);
    if (flag === undefined) return token;
    const option = declared.find(candidate => candidate.long === flag || candidate.short === flag);
    if (option === undefined) return undefined;
    if (takesValue(option, token) && index + 1 < tokens.length && !tokens[index + 1].startsWith("-")) index += 1;
  }
  return undefined;
}

function isBuiltinFlag(chain: readonly Command[], flag: string): boolean {
  if (flag === "--help" || flag === "-h") return true;
  return chain.length === 1 && (flag === "--version" || flag === "-V");
}

/** Findings for one span (the text after the opening backtick), without file position. */
export function checkSpan(root: Command, span: string): string[] {
  const tokens = span.trim().split(/\s+/).slice(1);
  const chain: Command[] = [root];
  const pathTokens: string[] = [];
  const flags: string[] = [];
  let pathOpen = true;
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    const flag = optionsEnded ? undefined : flagOf(token);
    if (flag !== undefined) {
      flags.push(flag);
      if (takesValue(findOption(chain, flag), token) && index + 1 < tokens.length && !tokens[index + 1].startsWith("-")) index += 1;
      continue;
    }
    if (!pathOpen) continue;
    if (PATH_END.test(token)) {
      pathOpen = false;
      continue;
    }
    const current = chain[chain.length - 1];
    const child = findChild(current, token);
    if (child) {
      chain.push(child);
      pathTokens.push(token);
      continue;
    }
    // `rh <path> help [<command>]` is Commander's implicit help command. `_dispatchHelpCommand(target)` prints help and exits 0 when this command resolves the target, and when there is none. A target it cannot resolve is a usage error, so the gate reports it. The same rule decides it here and in the manifest walk.
    if (implicitHelpCommand(current)?.name() === token) {
      const target = helpTarget(chain, tokens, index + 1);
      if (target === undefined || PATH_END.test(target) || findChild(current, target) !== undefined) return [];
      return [`unknown command "rh ${[...pathTokens, token, target].join(" ")}"`];
    }
    if (current.commands.length > 0 && current.registeredArguments.length === 0) {
      return [`unknown command "rh ${[...pathTokens, token].join(" ")}"`];
    }
    // `rh arch` and `rh arch projection` start archctx for an unregistered token; the disposition table decides whether it starts.
    if (pathTokens[0] === "arch" && current.commands.length > 0) {
      const refusal = archctxRefusal([...pathTokens.slice(1), token]);
      if (refusal !== null) return [`${refusal} in "rh ${[...pathTokens, token].join(" ")}"`];
    }
    pathOpen = false;
  }
  if (allowsUnknownOptions(chain[chain.length - 1])) return [];
  const path = chain.slice(1).map(command => command.name()).join(" ");
  const declared = effectiveOptions(chain);
  const findings: string[] = [];
  for (const flag of new Set(flags)) {
    if (isBuiltinFlag(chain, flag) || declared.some(option => option.long === flag || option.short === flag)) continue;
    findings.push(`unknown option "${flag}" for "rh${path === "" ? "" : ` ${path}`}"`);
  }
  return findings;
}

/** `file:line: finding` lines for one document. */
export function checkDocument(root: Command, file: string, text: string): string[] {
  const findings: string[] = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      if (!/^rh\s/.test(match[1])) continue;
      for (const finding of checkSpan(root, match[1])) findings.push(`${file}:${index + 1}: ${finding}`);
    }
  });
  return findings;
}

function main(): void {
  const repoIndex = process.argv.indexOf("--repo");
  const repo = resolve(repoIndex === -1 ? "." : process.argv[repoIndex + 1] ?? ".");
  const tracked = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const root = buildProgram();
  const findings = tracked
    .filter(file => SCANNED.some(pattern => pattern.test(file)))
    .flatMap(file => checkDocument(root, file, readFileSync(resolve(repo, file), "utf8")));
  for (const finding of findings) console.log(finding);
  process.exit(findings.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
