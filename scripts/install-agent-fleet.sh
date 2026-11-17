#!/bin/bash
set -euo pipefail

MIN_BUN_VERSION="1.4.0"

bun_version_is_supported() {
  local version="$1"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
  local minimum_major minimum_minor minimum_patch
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "$MIN_BUN_VERSION"
  (( major > minimum_major ||
    (major == minimum_major && minor > minimum_minor) ||
    (major == minimum_major && minor == minimum_minor && patch >= minimum_patch) ))
}

RUNTIME_BIN=""
BUN_VERSION=""
# A caller that already validated its Bun hands it over explicitly; only a
# standalone invocation discovers Bun by name.
if [[ -n "${REPO_HARNESS_BUN_BIN:-}" ]]; then
  BUN_CANDIDATES=("$REPO_HARNESS_BUN_BIN")
else
  BUN_CANDIDATES=("$(command -v bun 2>/dev/null || true)" "${HOME}/.bun/bin/bun")
fi
for candidate in "${BUN_CANDIDATES[@]}"; do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  candidate_version="$("$candidate" --version 2>/dev/null || true)"
  [[ -n "$BUN_VERSION" ]] || BUN_VERSION="$candidate_version"
  if bun_version_is_supported "$candidate_version"; then
    RUNTIME_BIN="$candidate"
    BUN_VERSION="$candidate_version"
    break
  fi
done

if [[ -z "$RUNTIME_BIN" && -z "$BUN_VERSION" ]]; then
  echo "install-agent-fleet.sh requires bun" >&2
  exit 1
fi
if [[ -z "$RUNTIME_BIN" ]]; then
  echo "install-agent-fleet.sh requires Bun >= ${MIN_BUN_VERSION} (found: ${BUN_VERSION:-unknown})" >&2
  exit 1
fi

helper_source="$0"
if [[ -n "${REPO_HARNESS_HELPER_SOURCE_PATH:-}" && -f "$REPO_HARNESS_HELPER_SOURCE_PATH" \
      && "$(basename "$REPO_HARNESS_HELPER_SOURCE_PATH")" == "$(basename "$0")" ]]; then
  helper_source="$REPO_HARNESS_HELPER_SOURCE_PATH"
fi
helper_dir="$(cd "$(dirname "$helper_source")" && pwd)"
case "$helper_dir" in
  */assets/templates/helpers)
    package_root="$(cd "$helper_dir/../../.." && pwd)"
    ;;
  */scripts)
    package_root="$(cd "$helper_dir/.." && pwd)"
    ;;
  *)
    echo "install-agent-fleet.sh cannot resolve repo-harness package root from helper path: $helper_source" >&2
    exit 1
    ;;
esac
AGENT_FLEET_SOURCE_DIR="$package_root/agents/fleet"
if [[ ! -d "$AGENT_FLEET_SOURCE_DIR" ]]; then
  echo "install-agent-fleet.sh missing packaged agent fleet source: $AGENT_FLEET_SOURCE_DIR" >&2
  exit 1
fi
export REPO_HARNESS_AGENT_FLEET_SOURCE_DIR="$AGENT_FLEET_SOURCE_DIR"

exec "$RUNTIME_BIN" - "$@" <<'NODE_EOF'
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const argv = process.argv.slice(2);
let force = false;
let acceptUserManaged = false;

function usage() {
  console.log("Usage: scripts/install-agent-fleet.sh [--force|--accept-user-managed]");
}

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--accept-user-managed") {
    acceptUserManaged = true;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  console.error(`Unknown argument: ${arg}`);
  usage();
  process.exit(1);
}
if (force && acceptUserManaged) {
  console.error("--force and --accept-user-managed are mutually exclusive");
  usage();
  process.exit(1);
}

const HOME = process.env.HOME ?? os.homedir();
const CLAUDE_TARGET_DIR = path.join(HOME, ".claude", "agents");
const CODEX_TARGET_DIR = path.join(HOME, ".codex", "agents");
const SOURCE_DIR = process.env.REPO_HARNESS_AGENT_FLEET_SOURCE_DIR;
const { readInstallState } = require(
  path.join(SOURCE_DIR, "../../src/cli/installer/install-profile.ts"),
);
const { pathRecordIsCurrent, pathRecordKey, readPathRecords } = require(
  path.join(SOURCE_DIR, "../../src/effects/host-config/path-records.ts"),
);
const { openHostConfigGate } = require(path.join(SOURCE_DIR, "../../src/effects/host-config/gate.ts"));
const { hostConfigPaths } = require(path.join(SOURCE_DIR, "../../src/effects/host-config/store.ts"));
const { migrateReplacedAgents } = require(path.join(SOURCE_DIR, "../../src/cli/installer/replaced-agents-migration.ts"));
const ENV = { ...process.env, HOME };
// The state check fails closed on a state that this package no longer reads.
readInstallState(ENV);
const gate = openHostConfigGate({ env: ENV });
// A fleet file that the user keeps is a `user_managed` path record; one that rh wrote is `created`, or `replaced`
// when it replaced a user file that the vault keeps. Read again after the one-shot migration below.
let records = readPathRecords(ENV);
const recordOf = (targetPath) => records[pathRecordKey(ENV, targetPath)];

// A generated persona carries role identity only. The anti-extras execution
// boundary belongs to the final runtime task packet, which is the only surface that knows
// whether the child is contract-bound and writable; a read-only persona must
// never be told to implement anything.

// Provider-native source tuples project deterministically to Codex-native labels.
// Validation remains fail-closed; reasoning effort is carried through unchanged.
const { MANAGED_AGENTS, WRITABLE_AGENTS, EFFORT_LEVELS, AGENT_TARGET_OVERRIDES,
  parseRoleNameScalar, parseFrontmatter, validateFrontmatter } = require(
  path.join(SOURCE_DIR, "../../src/effects/terminal/task-role-profiles.ts"),
);

function readSource(agent) {
  try {
    const text = fs.readFileSync(path.join(SOURCE_DIR, `${agent}.md`), "utf8");
    if (!text) return { ok: false, text: "" };
    return { ok: true, text };
  } catch (_error) {
    return { ok: false, text: "" };
  }
}


function tomlBasicString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function generateToml(agent, parsed, mapped) {
  const lines = [];
  const description = parsed.description.replace(mapped.sourceDescription, mapped.targetDescription);
  lines.push(`name = ${tomlBasicString(parsed.name)}`);
  lines.push(`description = ${tomlBasicString(description)}`);
  lines.push(`model = ${tomlBasicString(mapped.model)}`);
  lines.push(`model_reasoning_effort = ${tomlBasicString(mapped.effort)}`);
  if (WRITABLE_AGENTS.has(agent)) {
    lines.push(`sandbox_mode = "workspace-write"`);
  } else {
    lines.push(`sandbox_mode = "read-only"`);
  }
  lines.push(`developer_instructions = '''${parsed.body}'''`);
  return `${lines.join("\n")}\n`;
}

function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function readRegularFile(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, text: "" };
    return { ok: true, text: fs.readFileSync(targetPath, "utf8") };
  } catch (_error) {
    return { ok: false, text: "" };
  }
}

function validateUserManagedClaude(agent, content) {
  const parsed = parseFrontmatter(content);
  const model = parseRoleNameScalar(parsed?.model);
  const effort = parseRoleNameScalar(parsed?.effort);
  return Boolean(
    parsed
    && parsed.name === agent
    && parsed.description
    && model
    && effort
    && EFFORT_LEVELS.includes(effort)
    && parsed.body.trim(),
  );
}

function validateUserManagedCodex(agent, content) {
  try {
    const parsed = Bun.TOML.parse(content);
    if (parsed.name !== undefined && parsed.name !== agent) return false;
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return false;
    if (
      typeof parsed.model_reasoning_effort !== "string"
      || !EFFORT_LEVELS.includes(parsed.model_reasoning_effort)
    ) return false;
    if (typeof parsed.developer_instructions !== "string" || !parsed.developer_instructions.trim()) return false;
    if (
      parsed.sandbox_mode !== undefined
      && parsed.sandbox_mode !== "read-only"
      && parsed.sandbox_mode !== "workspace-write"
    ) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

/** One fleet file through the gate; an existing file keeps its mode. `replace` keeps a user file in the vault first. */
function writeAgent(targetPath, content, replace) {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  const mode = stat?.isFile() ? stat.mode & 0o777 : undefined;
  gate.writePaths([{ path: targetPath, owner: "core", entry: { type: "file", bytes: Buffer.from(content), ...(mode === undefined ? {} : { mode }) }, replace }]);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function compareAndWrite(targetPath, content, acceptedHash) {
  let existing = null;
  try {
    existing = fs.readFileSync(targetPath, "utf8");
  } catch (_error) {
    if (force && fs.existsSync(targetPath)) return "backup-failed";
    existing = null;
  }

  if (existing === content) return "up-to-date";

  // rh writes a fleet file only as a regular file; a link to a user file (also a dangling one) is follow-up #3102.
  if (fs.lstatSync(targetPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return `linked (links to ${fs.readlinkSync(targetPath)}; replace the link with a regular file, then run again)`;
  }

  if (existing === null) {
    writeAgent(targetPath, content, false);
    return "installed";
  }

  const owned = recordOf(targetPath);
  const current = (owned?.kind === "created" || owned?.kind === "replaced") && owned.committed.type === "file"
    && pathRecordIsCurrent(pathRecordKey(ENV, targetPath), owned);

  if (force && !current) {
    try {
      writeAgent(targetPath, content, true);
    } catch (_error) {
      return "backup-failed";
    }
    const { backup } = readPathRecords(ENV)[pathRecordKey(ENV, targetPath)];
    const copy = path.join(hostConfigPaths(ENV).vault, backup.slice("sha256:".length));
    return `replaced (backup: ${copy}; restore: cp ${shellQuote(copy)} ${shellQuote(targetPath)})`;
  }

  if (acceptedHash === sha256(existing)) return "user-managed";

  if (current) {
    writeAgent(targetPath, content, false);
    return "installed";
  }

  return "drift";
}

const results = [];
const prepared = [];

for (const agent of MANAGED_AGENTS) {
  const source = readSource(agent);
  if (!source.ok) {
    results.push({ host: "claude", file: `${agent}.md`, status: "source-missing" });
    results.push({ host: "codex", file: `${agent}.toml`, status: "source-missing" });
    continue;
  }

  const parsed = parseFrontmatter(source.text);
  const validation = validateFrontmatter(parsed, agent);
  if (!validation.ok) {
    results.push({ host: "claude", file: `${agent}.md`, status: "source-invalid" });
    results.push({ host: "codex", file: `${agent}.toml`, status: "source-invalid" });
    continue;
  }

  const target = AGENT_TARGET_OVERRIDES[agent];
  if (!target) {
    results.push({ host: "codex", file: `${agent}.toml`, status: "invalid-target" });
    continue;
  }
  const mapped = { sourceDescription: validation.sourceDescription, ...target };
  prepared.push({ agent, source: source.text, parsed, mapped });
}

if (prepared.length !== MANAGED_AGENTS.length) {
  for (const entry of results) console.log(`[fleet] ${entry.host}/${entry.file}: ${entry.status}`);
  process.exit(1);
}

const targets = prepared.flatMap(({ agent, source, parsed, mapped }) => {
  const tomlContent = generateToml(agent, parsed, mapped);
  Bun.TOML.parse(tomlContent);
  return [
    {
      agent,
      host: "claude",
      file: `${agent}.md`,
      path: path.join(CLAUDE_TARGET_DIR, `${agent}.md`),
      content: source,
    },
    {
      agent,
      host: "codex",
      file: `${agent}.toml`,
      path: path.join(CODEX_TARGET_DIR, `${agent}.toml`),
      content: tomlContent,
    },
  ];
});
for (const { path: targetPath, copy } of migrateReplacedAgents(ENV, targets)) {
  console.log(`[fleet] ${targetPath}: the user file in ${copy} is now in the rh vault; rh uninstall puts it back`);
}
records = readPathRecords(ENV);

if (acceptUserManaged) {
  const acceptedFiles = [];
  let invalid = false;
  for (const target of targets) {
    const existing = readRegularFile(target.path);
    if (!existing.ok) {
      results.push({ host: target.host, file: target.file, status: "user-managed-invalid" });
      invalid = true;
      continue;
    }
    if (existing.text === target.content) {
      results.push({ host: target.host, file: target.file, status: "up-to-date" });
      continue;
    }
    const valid = target.host === "claude"
      ? validateUserManagedClaude(target.agent, existing.text)
      : validateUserManagedCodex(target.agent, existing.text);
    if (!valid) {
      results.push({ host: target.host, file: target.file, status: "user-managed-invalid" });
      invalid = true;
      continue;
    }
    acceptedFiles.push(target.path);
    results.push({ host: target.host, file: target.file, status: "user-managed" });
  }
  for (const entry of results) console.log(`[fleet] ${entry.host}/${entry.file}: ${entry.status}`);
  if (invalid) process.exit(1);
  gate.keepUserPaths("core", targets.map((target) => target.path), acceptedFiles);
  console.log(`[fleet] user-managed records: accepted ${acceptedFiles.length} files`);
  process.exit(0);
}

for (const target of targets) {
  const kept = recordOf(target.path);
  const acceptedHash = !force && kept?.kind === "user_managed" ? kept.committed.sha256 : undefined;
  const status = compareAndWrite(target.path, target.content, acceptedHash);
  results.push({ host: target.host, file: target.file, status });
}

const failed = results.some((entry) => entry.status === "drift" || entry.status === "backup-failed" || entry.status.startsWith("linked"));
// A forced run takes every fleet file back, so the user's claims on them go.
if (force && !failed) gate.keepUserPaths("core", targets.map((target) => target.path), []);

for (const entry of results) {
  console.log(`[fleet] ${entry.host}/${entry.file}: ${entry.status}`);
}

process.exit(failed ? 1 : 0);
NODE_EOF
