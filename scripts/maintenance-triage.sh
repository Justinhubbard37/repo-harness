#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE_EOF'
Usage: scripts/maintenance-triage.sh [--json]
USAGE_EOF
}

output_mode="text"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      output_mode="json"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

ledger="tasks/lessons.md"

if [[ ! -f "$ledger" ]]; then
  if [[ "$output_mode" == "json" ]]; then
    printf '{"judgment":[],"field_errors":[],"evidence_errors":[]}\n'
  else
    echo "[Maintenance] No tasks/lessons.md found."
  fi
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[Maintenance] jq is required for maintenance triage." >&2
  exit 1
fi

# The one ledger parser. Each entry starts at `- Date:` and becomes
# {"line": <Date line>, "fields": {"<Field name>": "<value>"}}. An indented or
# unprefixed line continues the field above it; a blank line ends it.
entries_json="$(
  awk '
    function esc(value) {
      gsub(/\\/, "\\\\", value)
      gsub(/"/, "\\\"", value)
      gsub(/\t/, "\\t", value)
      gsub(/\r/, "", value)
      return value
    }
    function emit(   name, sep, body) {
      if (start == 0) {
        return
      }
      body = ""
      sep = ""
      for (name in fields) {
        body = body sep "\"" esc(name) "\":\"" esc(fields[name]) "\""
        sep = ","
      }
      printf "%s{\"line\":%d,\"fields\":{%s}}", (count++ ? "," : ""), start, body
      delete fields
      start = 0
      current = ""
    }
    /^- Date:/ {
      emit()
      start = NR
    }
    start == 0 {
      next
    }
    /^- [A-Z][A-Za-z ]*:/ {
      current = $0
      sub(/^- /, "", current)
      sub(/:.*/, "", current)
      value = $0
      sub(/^- [A-Z][A-Za-z ]*:[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
      fields[current] = value
      next
    }
    /^- / || /^[[:space:]]*$/ {
      current = ""
      next
    }
    current != "" {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      fields[current] = fields[current] " " line
    }
    END {
      emit()
    }
  ' "$ledger"
)"

# A consolidation commit replaces several ledger entries with fewer. An entry that
# keeps only such a commit as its Triggered by correction has lost the failure
# record it restates. Read the ledger history and list those commits. Outside a
# Git checkout the list is empty and the check cannot fail.
consolidation_refs() {
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  local sha subject before after
  while IFS=$'\t' read -r sha subject; do
    [[ -n "$sha" ]] || continue
    before="$(git show "$sha^:$ledger" 2>/dev/null | grep -c '^- Date: ' || true)"
    after="$(git show "$sha:$ledger" 2>/dev/null | grep -c '^- Date: ' || true)"
    (( before > after )) || continue
    printf '%s\n' "${sha:0:8}"
    if [[ "$subject" =~ \(#([0-9]+)\) ]]; then
      printf '#%s\n' "${BASH_REMATCH[1]}"
    fi
  done < <(git --no-pager log --format='%H%x09%s' -- "$ledger" 2>/dev/null)
}

consolidation_json="$(consolidation_refs | jq -R . | jq -s 'map(select(length > 0))')"

# Seen is the cumulative event count of a theme, so the latest entry of a theme
# carries its count and its current enforcement. A later repeat does not copy
# Promoted, so the theme keeps the last Promoted that any entry records.
report_json="$(
  jq -nc --argjson entries "[${entries_json}]" --argjson consolidation "${consolidation_json}" '
    def value($entry; $field): $entry.fields[$field] // "";
    def keyify: ascii_downcase | gsub("[^a-z0-9]+"; "-") | gsub("^-+|-+$"; "");
    def norm:
      ascii_downcase
      | gsub("^[[:space:]#]+|[[:space:]]+$"; "")
      | if test("^[0-9a-f]{8,40}$") then .[0:8] else . end;

    [ $entries[] as $entry
      | value($entry; "Mistake pattern") as $theme
      | ( {field: "Mistake pattern", ok: ($theme != ""), fix: "add the stable theme key"},
          {field: "Seen", ok: (value($entry; "Seen") | test("^[1-9][0-9]*×$")), fix: "write the cumulative event count of the theme as <N>×"},
          {field: "Enforced by", ok: (value($entry; "Enforced by") != ""), fix: "name the file that fails when the mistake comes back, or write judgment"} )
      | select(.ok | not)
      | {line: $entry.line, theme: $theme, field, value: value($entry; .field), fix}
    ] as $field_errors

    | ($consolidation | map(norm)) as $consolidations
    | [ $entries[] as $entry
        | value($entry; "Triggered by correction")
        | split(",")
        | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))
        | map(select(length > 0))
        | select(length > 0)
        | select((map(norm) - $consolidations | length) == 0)
        | {theme: value($entry; "Mistake pattern"), trigger: value($entry; "Triggered by correction")}
      ] as $evidence_errors

    | (if ($field_errors | length) > 0 then null else
        reduce $entries[] as $entry ({};
          (value($entry; "Mistake pattern") | keyify) as $key
          | value($entry; "Promoted") as $promoted
          | .[$key] += {
              theme: value($entry; "Mistake pattern"),
              name: (value($entry; "Name") | if . == "" then null else . end),
              seen: (value($entry; "Seen") | rtrimstr("×") | tonumber),
              enforced_by: value($entry; "Enforced by")
            }
          | if $promoted != "" then .[$key].promoted = $promoted else . end
        )
        | to_entries
        | map(select(.value.seen >= 3 and .value.enforced_by == "judgment")
            | {key, theme: .value.theme, name: .value.name, seen: .value.seen, promoted: (.value.promoted // null)})
      end) as $judgment

    | {judgment: $judgment, field_errors: $field_errors, evidence_errors: $evidence_errors}
  '
)"

error_count="$(jq '(.field_errors | length) + (.evidence_errors | length)' <<< "$report_json")"

if [[ "$output_mode" == "json" ]]; then
  printf '%s\n' "$report_json"
else
  if jq -e '.judgment == null' <<< "$report_json" >/dev/null; then
    echo "[Maintenance] Judgment themes are not computed until the field errors are fixed."
  else
    echo "[Maintenance] Themes enforced by judgment at Seen 3× or more:"
    jq -r '.judgment[] | "- \(.theme) (Seen \(.seen)×, \(if .promoted then "Promoted: \(.promoted)" else "not promoted" end))"' <<< "$report_json"
  fi
  if jq -e '.field_errors | length > 0' <<< "$report_json" >/dev/null; then
    echo "[Maintenance] Entries with a missing or malformed field:"
    jq -r --arg ledger "$ledger" '.field_errors[] | "- \($ledger):\(.line) \(.theme): \(.field) \"\(.value)\"; \(.fix)"' <<< "$report_json"
  fi
  if jq -e '.evidence_errors | length > 0' <<< "$report_json" >/dev/null; then
    echo "[Maintenance] Entries whose only Triggered by correction is a consolidation commit:"
    jq -r '.evidence_errors[] | "- \(.theme): \(.trigger)"' <<< "$report_json"
  fi
fi

[[ "$error_count" == "0" ]] || exit 1
