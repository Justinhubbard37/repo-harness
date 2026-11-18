#!/bin/bash
set -euo pipefail
# Script helpers must not write a Bun transpiler cache outside the gate plan.
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

RUNTIME_ROOT="$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)"
if [[ -z "${REPO_HARNESS_SYNC_DECLARED_PATHS_FILE+x}" ]]; then
  export REPO_HARNESS_SYNC_SHELL="$BASH"
  exec bun "$RUNTIME_ROOT/scripts/skill-surface-select.ts" sync-installed-copies "$@"
fi
[[ -f "$REPO_HARNESS_SYNC_DECLARED_PATHS_FILE" && -f "${REPO_HARNESS_SYNC_RETIRED_PATHS_FILE:-}" ]] || { echo "[sync-installed] gate path plan files are required" >&2; exit 1; }

SOURCE_ROOT="${REPO_HARNESS_SOURCE_ROOT:-}"
if [[ -z "$SOURCE_ROOT" ]]; then
  SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

SOURCE_ROOT="${SOURCE_ROOT%/}"
LINK_INSTALLED_COPIES="${REPO_HARNESS_LINK_INSTALLED_COPIES:-}"
# REPO_HARNESS_INSTALL_PLUGINS is the comma-separated plugin selection; an
# empty value selects core only. Unset, the sync projects every plugin, as a
# fresh install with no --plugins does. skill-surface-select.ts rejects an
# unknown id before any write.
if [[ -n "${REPO_HARNESS_INSTALL_PLUGINS+set}" ]]; then
  SELECTION_ARGS=(--plugins "$REPO_HARNESS_INSTALL_PLUGINS")
else
  SELECTION_ARGS=(--all-plugins)
fi
if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "[sync-installed] Source root not found: $SOURCE_ROOT" >&2
  exit 1
fi

# A process running the previously installed CLI loads its old TypeScript
# modules before `bun add -g` replaces the package. When that old updater reaches
# this newly installed script, perform the candidate's exact closure readback
# before projecting any host files. This makes the first update invocation fail
# closed instead of reporting success from stale in-memory update logic.
BUN_GLOBAL_ROOT="${BUN_INSTALL:-${HOME:-}/.bun}/install/global/node_modules/repo-harness"
if [[ -d "$BUN_GLOBAL_ROOT" ]] \
  && [[ "$(cd "$SOURCE_ROOT" && pwd -P)" == "$(cd "$BUN_GLOBAL_ROOT" && pwd -P)" ]]; then
  bun "$SOURCE_ROOT/scripts/check-managed-runtime.ts"
fi

# Resolved once, eagerly, here in the main shell process (never inside a function
# invoked as a pipeline's non-last stage -- bash forks a subshell for those, which
# would silently swallow a failure here as "selects nothing" instead of aborting).
# One adapter call returns the skill roots, facade selection and separately-managed
# provider placements so these boundaries do not add another Bun startup to every
# sync. src/effects/host-skill-roots.ts owns the root rule.
if ! SELECTION_PROJECTION="$(bun "$SOURCE_ROOT/scripts/skill-surface-select.ts" selection-projection "${SELECTION_ARGS[@]}")"; then
  echo "[sync-installed] skill-surface-select selection-projection failed for plugins: ${SELECTION_ARGS[*]}" >&2
  exit 1
fi
CODEX_SKILLS_ROOT=""
CLAUDE_SKILLS_ROOT=""
PI_SKILLS_ROOT=""
SKILL_ROOT_OVERRIDE=""
SELECTED_FACADES=""
PROVIDER_PLACEMENTS=""
INTEGRATION_NAMES=""
while IFS=$'\t' read -r projection_kind projection_value; do
  case "$projection_kind" in
    codex-root) CODEX_SKILLS_ROOT="$projection_value" ;;
    claude-root) CLAUDE_SKILLS_ROOT="$projection_value" ;;
    pi-root) PI_SKILLS_ROOT="$projection_value" ;;
    root-override) SKILL_ROOT_OVERRIDE="$projection_value" ;;
    facade) SELECTED_FACADES+="${SELECTED_FACADES:+$'\n'}$projection_value" ;;
    provider) PROVIDER_PLACEMENTS+="${PROVIDER_PLACEMENTS:+$'\n'}$projection_value" ;;
    integration) INTEGRATION_NAMES+="${INTEGRATION_NAMES:+$'\n'}$projection_value" ;;
  esac
done <<< "$SELECTION_PROJECTION"
if [[ -z "$CODEX_SKILLS_ROOT" || -z "$SKILL_ROOT_OVERRIDE" ]]; then
  echo "[sync-installed] skill-surface-select selection-projection returned no skill roots" >&2
  exit 1
fi
if [[ -z "$LINK_INSTALLED_COPIES" && "$SKILL_ROOT_OVERRIDE" == "0" ]]; then
  LINK_INSTALLED_COPIES=1
fi

# Manifest-derived name -> source path for every facade-kind package,
# regardless of the plugin selection. A facade's source directory is no longer guaranteed
# to live under one fixed assets/skill-commands/<name> parent (e.g.
# repo-harness-product sources from assets/skills/repo-harness-product), so
# every consumer below resolves the real source through this list instead of
# assuming a fixed parent directory.
if ! FACADE_SOURCES="$(bun "$SOURCE_ROOT/scripts/skill-surface-select.ts" facade-sources)"; then
  echo "[sync-installed] skill-surface-select facade-sources failed" >&2
  exit 1
fi
# Resolve copy authority beside the writer, not from an injected source tree.
if ! bun -e 'const { installedCopyTreeOptions } = await import(process.argv[1]); installedCopyTreeOptions("canonical-skill", await Bun.file(process.argv[2]).json());' \
  "$RUNTIME_ROOT/src/effects/managed-tree.ts" "$RUNTIME_ROOT/assets/workflow-contract.v1.json"; then
  echo "[sync-installed] installed copy projection is invalid." >&2
  exit 1
fi

require_rsync_for_copy_mode() {
  if command -v rsync >/dev/null 2>&1; then
    return 0
  fi
  echo "[sync-installed] unsupported copy-mode: rsync capability is missing." >&2
  echo "[sync-installed] Install rsync, or rerun with REPO_HARNESS_LINK_INSTALLED_COPIES=1 on a filesystem that supports symlinks." >&2
  exit 1
}

create_symlink_or_explain() {
  local source="$1"
  local dest="$2"
  if ln -s "$source" "$dest"; then
    return 0
  fi
  echo "[sync-installed] unsupported link-mode: symlink capability is unavailable for $dest." >&2
  echo "[sync-installed] Rerun with REPO_HARNESS_LINK_INSTALLED_COPIES=0 to use copy-mode; copy-mode requires rsync." >&2
  exit 1
}

managed_tree_hash() {
  local root="$1"
  local digest
  if ! digest="$(bun "$SOURCE_ROOT/scripts/skill-surface-select.ts" managed-tree-hash "$root")" || [[ -z "$digest" ]]; then
    echo "[sync-installed] managed-tree-hash failed for $root" >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

write_owner_marker() {
  local dest="$1"
  local surface="$2"
  local content_hash
  content_hash="$(managed_tree_hash "$dest")"
  printf '{"owner":"repo-harness","surface":"%s","content_hash":"%s"}\n' \
    "$(json_escape "$surface")" "$(json_escape "$content_hash")" \
    > "$dest/.repo-harness-owner.json"
}

refuse_unowned_dest() {
  local dest="$1"
  local reason="$2"
  echo "[sync-installed] Refusing to replace or remove $dest: $reason." >&2
  echo "[sync-installed] Preserve or move the unowned surface, then rerun." >&2
  return 1
}

path_in_list() {
  local wanted="$1" declared
  while IFS= read -r declared; do
    [[ "$declared" == "$wanted" ]] && return 0
  done
  return 1
}

assert_managed_dest() {
  local dest="$1"
  path_in_list "$dest" < "$REPO_HARNESS_SYNC_DECLARED_PATHS_FILE" \
    || refuse_unowned_dest "$dest" "path was not declared by the host-config gate"
}

remove_managed_dest() {
  local dest="$1"
  assert_managed_dest "$dest" || exit 1
  if [[ -L "$dest" ]]; then rm "$dest"
  elif [[ -e "$dest" ]]; then rm -rf "$dest"; fi
}

sync_copy() (
  local dest="$1"
  local source="${2:-$SOURCE_ROOT}"
  local surface="${3:-canonical-skill}"
  local copy_list
  require_rsync_for_copy_mode
  copy_list="$(mktemp /tmp/repo-harness-copy-files.XXXXXX)"
  trap 'rm -f "$copy_list"' EXIT
  # Resolve and validate the file list before replacing an owned destination.
  bun "$RUNTIME_ROOT/scripts/skill-surface-select.ts" installed-copy-files "$source" "$surface" \
    "$RUNTIME_ROOT/assets/workflow-contract.v1.json" > "$copy_list"
  remove_managed_dest "$dest"
  mkdir -p "$dest"
  rsync -a --from0 --files-from="$copy_list" "$source/" "$dest/"
  write_owner_marker "$dest" "$surface"
)

sync_claude_alias_links() {
  if [[ -z "$CLAUDE_SKILLS_ROOT" ]]; then
    return 0
  fi

  mkdir -p "$CLAUDE_SKILLS_ROOT"
  local alias_dest="$CLAUDE_SKILLS_ROOT/repo-harness"
  remove_managed_dest "$alias_dest"
  create_symlink_or_explain "$SOURCE_ROOT" "$alias_dest"
  echo "[sync-installed] Claude skill alias: $alias_dest -> $SOURCE_ROOT"
}

sync_claude_alias_copies() {
  if [[ -z "$CLAUDE_SKILLS_ROOT" ]]; then
    return 0
  fi

  mkdir -p "$CLAUDE_SKILLS_ROOT"
  local alias_dest="$CLAUDE_SKILLS_ROOT/repo-harness"
  sync_copy "$alias_dest" "$SOURCE_ROOT" canonical-skill
  echo "[sync-installed] Claude skill copy: $alias_dest"
}

facade_source_for() {
  local wanted="$1"
  local name source
  while IFS=$'\t' read -r name source; do
    if [[ "$name" == "$wanted" ]]; then
      printf '%s' "$source"
      return 0
    fi
  done <<< "$FACADE_SOURCES"
  printf ''
}

facade_selected() {
  local wanted="$1"
  path_in_list "$wanted" <<< "$SELECTED_FACADES"
}

provider_skill_for_root() {
  local root="$1"
  local wanted="$2"
  local host=""
  if [[ "$root" == "$CODEX_SKILLS_ROOT" ]]; then
    host="codex"
  elif [[ -n "$CLAUDE_SKILLS_ROOT" && "$root" == "$CLAUDE_SKILLS_ROOT" ]]; then
    host="claude"
  elif [[ -n "$PI_SKILLS_ROOT" && "$root" == "$PI_SKILLS_ROOT" ]]; then
    host="pi"
  fi
  [[ -n "$host" ]] && path_in_list "$host $wanted" <<< "$PROVIDER_PLACEMENTS"
}

# An integration skill is linked by its own
# explicit setup command. Facade preflight and retirement never own it.
integration_skill() {
  [[ -n "$INTEGRATION_NAMES" ]] && path_in_list "$1" <<< "$INTEGRATION_NAMES"
}

preflight_skill_root() {
  local root="$1"
  [[ -n "$root" ]] || return 0
  assert_managed_dest "$root/repo-harness" || exit 1
  local name source
  while IFS=$'\t' read -r name source; do
    [[ -n "$name" ]] || continue
    # Sparse packages can declare many facades without shipping their trees.
    # Skip them before scanning the selected-name list for each host.
    [[ -d "$SOURCE_ROOT/$source" && -f "$SOURCE_ROOT/$source/SKILL.md" ]] || continue
    facade_selected "$name" || continue
    assert_managed_dest "$root/$name" || exit 1
  done <<< "$FACADE_SOURCES"
}

remove_retired_owned_facades() {
  local root="$1"
  [[ -n "$root" && -d "$root" ]] || return 0
  local dest name source_rel source
  for dest in "$root"/repo-harness-*; do
    [[ -e "$dest" || -L "$dest" ]] || continue
    name="$(basename "$dest")"
    provider_skill_for_root "$root" "$name" && continue
    integration_skill "$name" && continue
    facade_selected "$name" && continue
    source_rel="$(facade_source_for "$name")"
    source=""
    [[ -n "$source_rel" ]] && source="$SOURCE_ROOT/$source_rel"
    if [[ -z "$source" || ! -d "$source" ]]; then
      echo "[sync-installed] retiring $dest: canonical facade source no longer exists in the package"
    fi
    if path_in_list "$dest" < "$REPO_HARNESS_SYNC_RETIRED_PATHS_FILE"; then
      remove_managed_dest "$dest"
    else
      echo "[sync-installed] preserving retired facade $dest. Run: rh upgrade" >&2
    fi
  done
}

# Keep default discovery bounded: the umbrella router plus the selection's
# manifest-selected facades. Specialized capabilities remain CLI
# subcommands/references. Driven by $FACADE_SOURCES (manifest-derived name ->
# source pairs for every facade-kind package) rather than a physical glob
# over one fixed parent directory, since a facade's source directory is no
# longer guaranteed to live under assets/skill-commands/<name>.
sync_command_facades() {
  local root="$1"
  local mode="$2"
  if [[ -z "$root" ]]; then
    return 0
  fi

  mkdir -p "$root"
  remove_retired_owned_facades "$root"
  local synced=0
  local name source facade_src dest
  while IFS=$'\t' read -r name source; do
    [[ -n "$name" ]] || continue
    facade_src="$SOURCE_ROOT/$source"
    [[ -d "$facade_src" && -f "$facade_src/SKILL.md" ]] || continue
    facade_selected "$name" || continue
    dest="$root/$name"
    if [[ "$mode" == "link" ]]; then
      remove_managed_dest "$dest"
      create_symlink_or_explain "$facade_src" "$dest"
    else
      sync_copy "$dest" "$facade_src" command-facade
    fi
    synced=$((synced + 1))
  done <<< "$FACADE_SOURCES"
  echo "[sync-installed] command facades ($mode): $synced into $root"
}



preflight_skill_root "$CODEX_SKILLS_ROOT"
preflight_skill_root "$CLAUDE_SKILLS_ROOT"
preflight_skill_root "$PI_SKILLS_ROOT"

canonical_dest="$CODEX_SKILLS_ROOT/repo-harness"
if [[ "$LINK_INSTALLED_COPIES" == "1" ]]; then
  mkdir -p "$CODEX_SKILLS_ROOT"
  remove_managed_dest "$canonical_dest"
  create_symlink_or_explain "$SOURCE_ROOT" "$canonical_dest"
  echo "[sync-installed] canonical skill link: $canonical_dest -> $SOURCE_ROOT"

  sync_command_facades "$CODEX_SKILLS_ROOT" link
  sync_claude_alias_links
  sync_command_facades "$CLAUDE_SKILLS_ROOT" link
  if [[ -n "$PI_SKILLS_ROOT" ]]; then
    mkdir -p "$PI_SKILLS_ROOT"
    remove_managed_dest "$PI_SKILLS_ROOT/repo-harness"
    create_symlink_or_explain "$SOURCE_ROOT" "$PI_SKILLS_ROOT/repo-harness"
    sync_command_facades "$PI_SKILLS_ROOT" link
  fi
  echo "[sync-installed] OK"
  exit 0
fi

sync_copy "$canonical_dest"
echo "[sync-installed] canonical skill copy: $canonical_dest"

sync_command_facades "$CODEX_SKILLS_ROOT" copy
sync_claude_alias_copies
sync_command_facades "$CLAUDE_SKILLS_ROOT" copy
if [[ -n "$PI_SKILLS_ROOT" ]]; then
  sync_copy "$PI_SKILLS_ROOT/repo-harness"
  sync_command_facades "$PI_SKILLS_ROOT" copy
fi
echo "[sync-installed] OK"
