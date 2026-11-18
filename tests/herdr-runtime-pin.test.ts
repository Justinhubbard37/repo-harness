import { renderHerdrSkill } from "../src/cli/commands/herdr-skill-render.mjs";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { run, withTempRepo } from "./helpers/repo-fixture";
import { ownedPath } from "../src/effects/host-config/path-records";
import { openHostConfigGate } from "../src/effects/host-config/gate";
import { configureRequiredHerdrSkill } from "../src/cli/commands/herdr-skill";
import { ensureHerdrCore } from "../src/cli/commands/global-runtime";
import { startFakeHcRelease } from "./helpers/fake-hc";
import { HC_MIN_VERSION } from "../src/core/terminal/herdr-pin";
import { sha256Prefixed } from "../src/core/evidence/sha256";

/**
 * The package file `src/core/terminal/herdr-core-pin.json` is the single herdr
 * runtime pin. These are drift checks for its readers: CI and the readiness
 * script must derive the floor, URL, and checksum from that file instead of
 * restating them.
 */
const ROOT = join(import.meta.dir, "..");
const PIN_FILE = "src/core/terminal/herdr-core-pin.json";
const CI_PATH = join(ROOT, ".github/workflows/ci.yml");
const SCRIPT_PATH = join(ROOT, "scripts/check-agent-tooling.sh");

function readPin() {
  return JSON.parse(readFileSync(join(ROOT, PIN_FILE), "utf8"));
}

function herdrInstallStep() {
  const action = Bun.YAML.parse(readFileSync(join(ROOT, '.github/actions/install-pinned-herdr-core/action.yml'), 'utf8')) as {
    runs: { using: string; steps: Array<{ shell: string; run: string }> };
  };
  expect(action.runs.using).toBe('composite');
  expect(action.runs.steps).toHaveLength(1);
  expect(action.runs.steps[0]!.shell).toBe('bash');
  return action.runs.steps[0]!.run;

}

describe("herdr runtime pin has one source of truth", () => {
  test("the herdr-core pin names an official release asset for each platform of the 0.1.21 manifest", () => {
    const core = readPin();
    expect(core.min_version).toBe("0.1.21");
    for (const platform of ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64', 'windows-x86_64']) {
      const asset = core.release_assets?.[platform];
      expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset?.url).toBe(`https://releases.herdr.dev/core/${core.min_version}/herdr-core-${platform}.${platform.startsWith('windows') ? 'zip' : 'tar.gz'}`);
    }
  });

  test("each CI job installs hc from the pin before its tests", () => {
    const workflow = Bun.YAML.parse(readFileSync(CI_PATH, 'utf8')) as {
      jobs: Record<string, { steps: Array<{ name?: string; uses?: string; if?: string; run?: string }> }>;
    };
    for (const job of ['native-oar', 'verify', 'test']) {
      const steps = workflow.jobs[job]!.steps;
      const core = steps.findIndex(step => step.name === 'Install pinned herdr-core runtime'
        && step.uses === './.github/actions/install-pinned-herdr-core');
      expect(core, job).toBeGreaterThan(-1);
      expect(steps[core]!.if, job).toBeUndefined();
    }
    const nativeSteps = workflow.jobs['native-oar']!.steps;
    const install = nativeSteps.findIndex(step => step.uses === './.github/actions/install-pinned-herdr-core');
    expect(install).toBeLessThan(nativeSteps.findIndex(step => step.name === 'Run native OAR acceptance tests'));
    const step = herdrInstallStep();
    expect(step).toContain(`pin='${PIN_FILE}'`);
    expect(step).toContain("'.min_version'");
    expect(step).toContain("'.release_assets[$asset].url'");
    expect(step).toContain("'.release_assets[$asset].sha256'");
    expect(step).toContain("sha256sum --check");
    expect(step).toContain('shasum -a 256 --check');
    expect(step).toContain('"$bin/hc" --version');
    expect(step).toContain('GITHUB_PATH');
    // No hardcoded version, release tag, or checksum may survive in the step.
    expect(step).not.toMatch(/v?\d+\.\d+\.\d+/);
    expect(step).not.toMatch(/[0-9a-f]{64}/);
  });

  test("the probe workflow keeps the setup pins of the CI jobs that it predicts", () => {
    type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
    const steps = (path: string, job: string) => (Bun.YAML.parse(readFileSync(join(ROOT, path), 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    }).jobs[job]!.steps;
    const pins = (list: Step[]) => ({
      node: list.find(step => step.uses === 'actions/setup-node@v4')?.with?.['node-version'],
      bun: list.find(step => step.uses === 'oven-sh/setup-bun@v2')?.with?.['bun-version'],
      apt: list.filter(step => step.run?.includes('apt-get install')).map(step => step.run),
      herdr: list.filter(step => step.uses === './.github/actions/install-pinned-herdr-core').length,
    });
    const probe = pins(steps('.github/workflows/probe.yml', 'probe'));
    expect(probe.node).toBeDefined();
    const ci = '.github/workflows/ci.yml';
    expect(probe).toEqual(pins(steps(ci, 'verify')));
    const home = pins(steps(ci, 'home-isolation'));
    expect([probe.node, probe.bun]).toEqual([home.node, home.bun]);
  });

  test.each([
    ["the pinned digest", true],
    ["a wrong digest", false],
  ])("the herdr-core install with %s", (_label, digestMatches) => withTempRepo('hc-install', root => {
    const version = readPin().min_version;
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg/herdr-core'), `#!/bin/sh\necho "hc ${version}"\n`, { mode: 0o755 });
    expect(run('tar', ['-czf', 'asset.tar.gz', '-C', 'pkg', 'herdr-core'], root).status).toBe(0);
    const digest = new Bun.CryptoHasher('sha256').update(readFileSync(join(root, 'asset.tar.gz'))).digest('hex');
    const asset = { url: `file://${join(root, 'asset.tar.gz')}`, sha256: digestMatches ? digest : '0'.repeat(64) };
    const release_assets = Object.fromEntries(['linux-x86_64', 'macos-aarch64', 'macos-x86_64'].map(platform => [platform, asset]));
    mkdirSync(join(root, dirname(PIN_FILE)), { recursive: true });
    writeFileSync(join(root, PIN_FILE), JSON.stringify({ min_version: version, release_assets }));
    mkdirSync(join(root, 'runner'));
    const result = run('bash', ['-c', herdrInstallStep()], root, {
      RUNNER_TEMP: join(root, 'runner'), GITHUB_PATH: join(root, 'github-path'),
    });
    expect(result.status, result.stderr).toBe(digestMatches ? 0 : 1);
    expect(existsSync(join(root, 'runner/herdr-core-bin/hc'))).toBe(digestMatches);
    expect(existsSync(join(root, 'github-path'))).toBe(digestMatches);
    if (digestMatches) expect(result.stdout).toContain(`hc ${version}`);
  }));

  test("check-agent-tooling.sh carries no hand-coded herdr version floor", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    expect(script).toContain(`const HERDR_CORE_PIN_SOURCE = "package:${PIN_FILE}";`);
    expect(script).toContain('require(path.join(PACKAGE_ROOT, "src", "core", "terminal", "herdr-core-pin.json"))');
    expect(script).not.toContain(".ai/harness/policy.json#external_tooling.herdr_core");
    const herdrLines = script.split("\n").filter((line) => /herdr/i.test(line));
    expect(herdrLines.length).toBeGreaterThan(0);
    // The floor checks carry no "herdr" text on every line, so scan their whole bodies.
    for (const name of ["versionAtLeast", "herdrCoreCapability"]) {
      const start = script.indexOf(`\nfunction ${name}(`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      herdrLines.push(...script.slice(start, script.indexOf("\n}\n", start)).split("\n"));
    }
    for (const line of herdrLines) {
      expect(line).not.toMatch(/\d+\.\d+\.\d+/);
      expect(line).not.toMatch(/minor\s*[<>]=?\s*\d|\[2\]\)\s*[<>]/);
    }
  });

  test("the browser bundle can read the hc pin check", () => {
    // operator-web builds without Node built-ins, so the hc version check must stay in core.
    const pin = readFileSync(join(ROOT, 'src/core/terminal/herdr-pin.ts'), 'utf8');
    expect(pin).not.toMatch(/from '(node:|\.[^']*(effects|operator-web)\b)/);
  });
});

// The first lines of `hc --skill` from the pinned herdr-core 0.1.18 release.
const HC_MANUAL = "# hc manual (herdr-core)\n\nThe current manual for herdr-core's CLI, `hc`. It is not `herdr`, the older\nterminal multiplexer.\n\n"
  + "# hc: programs and agents that stay alive\n\n`$HC_TERMINAL_ID` is your address. Terminals you start are your children.\n";

test("Herdr skill puts the hc manual verbatim under the caller-context policy", () => {
  const rendered = renderHerdrSkill(HC_MANUAL);
  expect(rendered.startsWith("---\nname: herdr\n")).toBe(true);
  expect(rendered).toContain("Missing variables do not prove");
  expect(rendered).toContain("hc ls --json");
  expect(rendered).toContain("Read-only discovery does not require");
  expect(rendered).toContain("If no suitable reviewer exists, start one");
  expect(rendered).not.toContain("HERDR_ENV");
  expect(rendered.endsWith(`(\`hc --skill\`).\n\n${HC_MANUAL}`)).toBe(true);
  expect(() => renderHerdrSkill("---\nname: herdr\n---\nCheck HERDR_ENV before control.\n\n## Learn the current CLI\n")).toThrow("hc --skill did not return the hc manual");
});

test("Herdr skill renderer loads from an npm package path under Node", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-render-package-"));
  try {
    const packageRoot = join(root, "node_modules", "repo-harness");
    for (const file of ["src/cli/commands/herdr-skill-render.mjs", "assets/reference-configs/herdr-skill-context.md"]) {
      const target = join(packageRoot, file);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, readFileSync(join(ROOT, file)));
    }
    const upstream = HC_MANUAL;
    const result = spawnSync("node", ["-e", "const {renderHerdrSkill}=require(process.argv[1]); process.stdout.write(renderHerdrSkill(process.argv[2]));", join(packageRoot, "src/cli/commands/herdr-skill-render.mjs"), upstream], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderHerdrSkill(upstream));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("required Herdr skill records its writes and keeps unrecorded or edited copies", () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-herdr-gate-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const source = join(root, 'skill.md');
    mkdirSync(home); mkdirSync(bin);
    const hc = join(bin, 'hc');
    writeFileSync(hc, '#!/bin/sh\ncat "$FIXTURE_SKILL_FILE"\n'); chmodSync(hc, 0o755);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: bin + ':' + process.env.PATH, FIXTURE_SKILL_FILE: source };
    writeFileSync(source, HC_MANUAL);
    const classic = join(home, '.claude/skills/herdr');
    mkdirSync(classic, { recursive: true });
    writeFileSync(join(classic, 'SKILL.md'), 'classic user copy\n');
    expect(configureRequiredHerdrSkill('both', env).status).toBe('failed');
    expect(readFileSync(join(classic, 'SKILL.md'), 'utf8')).toBe('classic user copy\n');
    expect(existsSync(join(home, '.codex/skills/herdr'))).toBe(false);
    rmSync(classic, { recursive: true });
    expect(configureRequiredHerdrSkill('both', env).status).toBe('ok');
    const codex = join(home, '.codex/skills/herdr');
    for (const path of [classic, codex]) {
      expect(ownedPath(env, path)).toMatchObject({ kind: 'created', owner: 'core' });
      expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe(renderHerdrSkill(HC_MANUAL));
    }
    const shared = join(home, '.agents/skills/herdr');
    openHostConfigGate({ env }).writePaths([{ path: shared, owner: 'core', entry: { type: 'directory', source: codex } }]);
    const next = HC_MANUAL + 'Use hc ls.\n';
    writeFileSync(source, next);
    expect(configureRequiredHerdrSkill('both', env).status).toBe('ok');
    for (const path of [classic, codex, shared]) expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe(renderHerdrSkill(next));
    // A marker directory is user content, although the tree hash excludes the marker.
    const marker = join(codex, '.repo-harness-owner.json');
    rmSync(marker); mkdirSync(marker); writeFileSync(join(marker, 'keep.txt'), 'keep\n');
    expect(configureRequiredHerdrSkill('both', env).status).toBe('failed');
    expect(readFileSync(join(marker, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(classic, 'SKILL.md'), 'utf8')).toBe(renderHerdrSkill(next));
    rmSync(marker, { recursive: true });
    writeFileSync(marker, '{}');
    writeFileSync(join(shared, 'SKILL.md'), 'user change\n');
    writeFileSync(source, next + 'New rule.\n');
    expect(configureRequiredHerdrSkill('both', env).status).toBe('failed');
    expect(readFileSync(join(shared, 'SKILL.md'), 'utf8')).toBe('user change\n');
    expect(readFileSync(join(codex, 'SKILL.md'), 'utf8')).toBe(renderHerdrSkill(next));
    writeFileSync(hc, '#!/bin/sh\nkill -TERM $$\n');
    expect(configureRequiredHerdrSkill('both', env).detail).toBe('hc --skill failed: signal SIGTERM');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("required Herdr skill follows a linked host parent and leaves retired stages alone", () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-herdr-parent-'));
  try {
    const home = join(root, 'home'), outside = join(root, 'outside'), bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(outside); mkdirSync(bin);
    symlinkSync(outside, join(home, '.codex'), 'dir');
    const stage = join(outside, 'skills', '.herdr-stage-old123');
    mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, 'keep.txt'), 'keep\n');
    const cleanStage = join(outside, 'skills', '.herdr-stage-clean1');
    const oldContent = renderHerdrSkill(HC_MANUAL);
    mkdirSync(cleanStage); writeFileSync(join(cleanStage, 'SKILL.md'), oldContent);
    writeFileSync(join(cleanStage, '.repo-harness-owner.json'), JSON.stringify({ owner: 'repo-harness', sha256: sha256Prefixed(oldContent) }));
    utimesSync(cleanStage, new Date(0), new Date(0));
    writeFileSync(join(bin, 'hc'), '#!/bin/sh\ncat "$FIXTURE_SKILL_FILE"\n'); chmodSync(join(bin, 'hc'), 0o755);
    const source = join(root, 'skill.md'); writeFileSync(source, HC_MANUAL);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: bin + ':' + process.env.PATH, FIXTURE_SKILL_FILE: source };
    expect(configureRequiredHerdrSkill('codex', env).status).toBe('ok');
    expect(readFileSync(join(outside, 'skills/herdr/SKILL.md'), 'utf8')).toBe(renderHerdrSkill(HC_MANUAL));
    expect(ownedPath(env, join(home, '.codex/skills/herdr'))?.kind).toBe('created');
    expect(readFileSync(join(stage, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(cleanStage, 'SKILL.md'), 'utf8')).toBe(oldContent);
    expect(ownedPath(env, join(home, '.codex/skills', '.herdr-stage-clean1'))).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

interface HcStepRow {
  readonly label: string;
  /** The hc version on PATH before the step; null: no hc on PATH. */
  readonly before: string | null;
  readonly platform: string;
  readonly served: "pinned" | "tampered" | "absent" | "wrong-version" | "no-conpty";
  readonly existing?: "herdr-core" | "hc";
  readonly updateFails?: boolean;
  readonly updateLeavesVersion?: boolean;
  readonly installDirOnPath?: boolean;
  /** Windows: the fake powershell.exe fails its user PATH write. */
  readonly userPathFails?: boolean;
  /** Windows: user PATH writes through powershell.exe. */
  readonly userPathCalls?: number;
  readonly status: "ok" | "failed";
  readonly requests: number;
  readonly installed: boolean;
  readonly hcCalls: readonly string[];
  /** Text that the step detail contains; a function gets the install dir. */
  readonly detail?: string | ((installDir: string) => string);
}

const HC_STEP_ROWS: readonly HcStepRow[] = [
  { label: "missing: installs the pinned asset", before: null, platform: "darwin-arm64", served: "pinned", installDirOnPath: true, status: "ok", requests: 1, installed: true, hcCalls: [] },
  { label: "missing: a dir not on PATH installs with a hint", before: null, platform: "darwin-arm64", served: "pinned", status: "ok", requests: 1, installed: true, hcCalls: [], detail: "to PATH to use hc" },
  { label: "missing: a sha256 mismatch installs nothing", before: null, platform: "darwin-arm64", served: "tampered", status: "failed", requests: 1, installed: false, hcCalls: [], detail: "sha256 mismatch" },
  { label: "missing: a failed download installs nothing", before: null, platform: "darwin-arm64", served: "absent", status: "failed", requests: 1, installed: false, hcCalls: [], detail: "download of" },
  { label: "missing: an hc of another version installs nothing", before: null, platform: "darwin-arm64", served: "wrong-version", status: "failed", requests: 1, installed: false, hcCalls: [], detail: "the downloaded hc reports 0.0.1" },
  { label: "missing: an existing herdr-core file is not overwritten", before: null, platform: "darwin-arm64", served: "pinned", existing: "herdr-core", status: "failed", requests: 0, installed: false, hcCalls: [],
    detail: dir => `refusing to overwrite it; add ${dir} to PATH, then rerun rh update` },
  { label: "missing: a dangling hc link is not overwritten", before: null, platform: "darwin-arm64", served: "pinned", existing: "hc", status: "failed", requests: 0, installed: false, hcCalls: [],
    detail: dir => `refusing to overwrite it; add ${dir} to PATH, then rerun rh update` },
  { label: "missing on Windows: installs herdr-core.exe, conpty and the hc.exe hard link, and adds the dir to the user PATH", before: null, platform: "win32-x64", served: "pinned", status: "ok", requests: 1, installed: true, hcCalls: [],
    userPathCalls: 1, detail: "to the user PATH: new terminals have hc; this run uses it for its later steps" },
  { label: "missing on Windows: a failed user PATH write fails the step", before: null, platform: "win32-x64", served: "pinned", userPathFails: true, status: "failed", requests: 1, installed: true, hcCalls: [],
    userPathCalls: 1, detail: "to the user PATH failed: registry access denied" },
  { label: "missing on Windows: a zip without conpty installs nothing", before: null, platform: "win32-x64", served: "no-conpty", status: "failed", requests: 1, installed: false, hcCalls: [], userPathCalls: 0, detail: "holds no complete hc (missing conpty, conpty/conpty.dll)" },
  { label: "missing: no pin target for the platform", before: null, platform: "win32-arm64", served: "pinned", status: "failed", requests: 0, installed: false, hcCalls: [],
    detail: `no herdr-core release asset for win32-arm64; install hc >=${HC_MIN_VERSION} manually (Herdr.app or a herdr-core release), then run rh update` },
  { label: "below the floor: hc update --version", before: "0.1.15", platform: "darwin-arm64", served: "pinned", status: "ok", requests: 0, installed: false,
    hcCalls: ["--version", `update --version ${HC_MIN_VERSION}`, "--version"], detail: `hc client 0.1.15 was below the repo-harness floor ${HC_MIN_VERSION}; hc update --version ${HC_MIN_VERSION} updated it to ${HC_MIN_VERSION}` },
  { label: "below the floor: a failed hc update stops", before: "0.1.15", platform: "darwin-arm64", served: "pinned", updateFails: true, status: "failed", requests: 0, installed: false,
    hcCalls: ["--version", `update --version ${HC_MIN_VERSION}`], detail: `hc client 0.1.15 is below the repo-harness floor ${HC_MIN_VERSION}; hc update --version ${HC_MIN_VERSION} failed: hc: managed install; update it with its package manager` },
  { label: "below the floor: hc update leaves the client below the floor", before: "0.1.15", platform: "darwin-arm64", served: "pinned", updateLeavesVersion: true, status: "failed", requests: 0, installed: false,
    hcCalls: ["--version", `update --version ${HC_MIN_VERSION}`, "--version"], detail: `hc update --version ${HC_MIN_VERSION} left hc client 0.1.15 below the repo-harness floor ${HC_MIN_VERSION}` },
  { label: "at the floor: no change", before: HC_MIN_VERSION, platform: "darwin-arm64", served: "pinned", status: "ok", requests: 0, installed: false, hcCalls: ["--version"] },
  { label: "above the floor: no change", before: "99.0.0", platform: "darwin-arm64", served: "pinned", status: "ok", requests: 0, installed: false, hcCalls: ["--version"] },
];

test.each(HC_STEP_ROWS.map(row => [row.label, row] as const))("herdr-core install step, %s", async (_label, row) => {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-hc-step-"));
  const windows = row.platform.startsWith("win32");
  const release = join(root, "release"), pkg = join(root, "pkg"), home = join(root, "home"), fakeBin = join(root, "bin");
  const localAppData = join(root, "LocalAppData"), systemRoot = join(root, "Windows");
  const installDir = windows ? join(localAppData, "Programs", "herdr-core") : join(home, ".local", "bin");
  for (const dir of [release, pkg, fakeBin, installDir, join(systemRoot, "System32")]) mkdirSync(dir, { recursive: true });
  const server = startFakeHcRelease(root, release);
  try {
    // The official archive layout. The Windows zip is a tar.gz here: the fake tar.exe is the host tar.
    const binary = windows ? "herdr-core.exe" : "herdr-core";
    writeFileSync(join(pkg, binary), `#!/bin/sh\necho "hc ${row.served === "wrong-version" ? "0.0.1" : HC_MIN_VERSION}"\n`, { mode: 0o755 });
    if (windows && row.served !== "no-conpty") { mkdirSync(join(pkg, "conpty")); writeFileSync(join(pkg, "conpty", "conpty.dll"), "dll\n"); }
    writeFileSync(join(systemRoot, "System32", "tar.exe"), '#!/bin/sh\nexec tar "$@"\n', { mode: 0o755 });
    // A fake powershell.exe: it logs the encoded command and prints what the registry script prints.
    mkdirSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
    writeFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), `#!/bin/sh\nprintf '%s\\n' "$4" >> "${root}/powershell.log"\n`
      + (row.userPathFails ? "echo 'registry access denied' >&2; exit 1\n" : "echo added\n"), { mode: 0o755 });
    expect(spawnSync("tar", ["-czf", join(root, "asset"), "-C", pkg, "."]).status).toBe(0);
    const archive = readFileSync(join(root, "asset"));
    const assetFile = windows ? "herdr-core-windows-x86_64.zip" : "herdr-core-macos-aarch64.tar.gz";
    if (row.served !== "absent") writeFileSync(join(release, assetFile), row.served === "tampered" ? Buffer.concat([archive, Buffer.from("x")]) : archive);
    // Neither entry is an hc on PATH: a user file named herdr-core, and a link to a removed binary.
    if (row.existing === "herdr-core") writeFileSync(join(installDir, "herdr-core"), "user file\n");
    if (row.existing === "hc") symlinkSync("removed-herdr-core", join(installDir, "hc"));
    // A fake hc: it logs each call; `update --version X` sets its version to X.
    if (row.before !== null) {
      writeFileSync(join(root, "hc-version"), row.before);
      writeFileSync(join(fakeBin, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${root}/hc-argv.log"\n`
        + `if [ "$1" = update ]; then ${row.updateFails ? `echo 'hc: managed install; update it with its package manager' >&2; exit 1` : row.updateLeavesVersion ? 'exit 0' : `printf '%s' "$3" > "${root}/hc-version"; exit 0`}; fi\n`
        + `printf 'hc %s\\n' "$(cat "${root}/hc-version")"\n`, { mode: 0o755 });
    }
    const port = await server.port;
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const { step, pathEntry } = ensureHerdrCore({
      cwd: root, command: "update", platform: row.platform, minVersion: HC_MIN_VERSION,
      assets: Object.fromEntries(["macos-aarch64", "windows-x86_64"].map(name => [name, { url: `http://127.0.0.1:${port}/${assetFile}`, sha256 }])),
      env: { HOME: home, LOCALAPPDATA: localAppData, SystemRoot: systemRoot, PATH: `${row.installDirOnPath ? `${installDir}:` : ""}${fakeBin}:/usr/bin:/bin` },
    });
    expect(step.status, step.detail).toBe(row.status);
    if (row.detail !== undefined) expect(step.detail).toContain(typeof row.detail === "string" ? row.detail : row.detail(installDir));
    if (row.installDirOnPath) expect(step.detail).not.toContain("to PATH");
    expect(pathEntry).toBe(row.status === "ok" && row.installed && !row.installDirOnPath ? installDir : null);
    expect(server.requests()).toHaveLength(row.requests);
    expect(existsSync(join(root, "hc-argv.log")) ? readFileSync(join(root, "hc-argv.log"), "utf8").split("\n").filter(Boolean) : []).toEqual([...row.hcCalls]);
    const userPathCommands = existsSync(join(root, "powershell.log")) ? readFileSync(join(root, "powershell.log"), "utf8").split("\n").filter(Boolean) : [];
    expect(userPathCommands).toHaveLength(row.userPathCalls ?? 0);
    for (const command of userPathCommands) {
      const script = Buffer.from(command, "base64").toString("utf16le");
      expect(script).toContain(`$dir = '${installDir}'`);
      expect(script).toContain("DoNotExpandEnvironmentNames");
    }
    if (row.existing === "herdr-core") expect(readFileSync(join(installDir, "herdr-core"), "utf8")).toBe("user file\n");
    if (row.existing === "hc") expect(readlinkSync(join(installDir, "hc"))).toBe("removed-herdr-core");
    if (!row.installed) {
      if (row.existing === undefined) expect(readdirSync(installDir)).toEqual([]);
    } else if (windows) {
      expect(readdirSync(installDir).sort()).toEqual(["conpty", "hc.exe", "herdr-core.exe"]);
      expect(existsSync(join(installDir, "conpty", "conpty.dll"))).toBe(true);
      expect(lstatSync(join(installDir, "hc.exe")).ino).toBe(lstatSync(join(installDir, "herdr-core.exe")).ino);
    } else {
      expect(readdirSync(installDir).sort()).toEqual(["hc", "herdr-core"]);
      expect(readlinkSync(join(installDir, "hc"))).toBe("herdr-core");
      expect(spawnSync(join(installDir, "hc"), ["--version"], { encoding: "utf8" }).stdout).toBe(`hc ${HC_MIN_VERSION}\n`);
    }
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
