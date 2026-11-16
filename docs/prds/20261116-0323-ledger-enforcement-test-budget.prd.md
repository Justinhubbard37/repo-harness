# PRD: Ledger enforcement and the test-budget CI loop

> **Status**: Draft
> **Slug**: ledger-enforcement-test-budget
> **Created**: 2026-11-16 03:23
> **Updated**: 2026-11-16 03:23
> **Tier**: standard
> **Source Spec**: [docs/spec.md](../spec.md) § Workflow Surfaces; [Lessons Retro](../reference-configs/agentic-development-flow.md#lessons-retro); the test-budget rule in [AGENTS.md § Testing](../../AGENTS.md#testing)
> **Parent**: [#2809](https://github.com/aimpact-inc/repo-harness/issues/2809). The parent holds the plan, the owner decisions and the record of how this program reached its rules; this PRD keeps the result only.
> **Baseline**: `origin/main@67e13cc8671ebc85614375ec80fe2f4929ef3eae`, which includes the ledger specification of `#2812` (#2830) and the result contract [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) of `#2816` (#2831).
> **Source draft**: the owner's PRD draft v3, https://claude.ai/artifact/43uZMVZG2txkBFWqcQGDZG. This file is the repository copy of that version.

## AI Quick-Read Card

- Problem: two written rules have no check. `tasks/lessons.md` has a specification and no enforcement. The test budget in `AGENTS.md` gives caps and a measure command, and no CI job runs it. A PR that breaks either rule passes `Required / CI`.
- Users: the maintainer who reads the ledger and the merge state; the agents that write ledger entries and open PRs.
- Platform: `scripts/check-ci.sh` lanes, the GitHub workflow `.github/workflows/ci.yml`, the `.ai/harness/policy.json` rule switch, and the repo-harness merge path.
- P0 surface: the ledger data contract, the `LedgerEnforcement` check, the `TestBudget` rule and its exception parser, the merge-readiness consumer, the human summary.
- Core metric: a repeat of a ledger contract violation, or a PR over the budget without a valid exception, cannot merge through repo-harness.
- Hard constraint: the budget caps keep one authority. This PRD links them and does not restate the numbers. A check error is never a pass.
- Key risk: both rules change what `Required / CI` accepts. A false pass hides a violation; a false fail blocks ordinary work. The result states keep them apart.
- Unknowns: at `#2811` start the result transport from a CI runner to merge readiness had no path. [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) (`#2816`, merged as #2831) decided it.
- Acceptance scenarios: one positive and one negative scenario for each P0 module, in `## Acceptance Scenarios`.
- Suggested next step: `#2816` decides the `TestBudget` result contract; `#2813` migrates the ledger to the fields that `#2812` set.

## Problem

### Product Direction

- Hard Constraints:
  - One authority for each value. The ledger fields have the Lessons Retro specification. The budget caps have the effective rule configuration.
  - A check error is not a pass. A skipped check is a separate result.
  - New rules are off by default in adopted repositories. `off`, `no configuration` and `invalid configuration` are three different results.
  - The merge guarantee covers the repo-harness merge path only. A merge from the GitHub web page stays outside the first version.
- Recommended Defaults:
  - The rule ids are `LedgerEnforcement` and `TestBudget`. The registry, the policy, the ledger and each result use this spelling.
  - The checks run as `scripts/check-ci.sh` work and report through `Required / CI`, not as a new service.
  - The first version does not connect the Stop hook. The CI loop does not depend on a Stop event.
- Freedoms:
  - The storage path and the transport for a rule result. `#2816` chooses them in an ADR.
  - The file layout of the rule module under `src/core`.
  - The summary surface, provided that it holds no state and keeps the original numbers.

### Feasibility Boundary

- Confirmed:
  - At `cc7cf86`, `tasks/lessons.md` has 16 entries. None has `Name`, `Enforced by` or `Missed by`. Ten entries have `Seen` of 3 or more.
  - `scripts/maintenance-triage.sh` reads `Mistake pattern`, `Prevention rule` and `Triggered by correction`. It counts entries for each theme and does not read `Seen`.
  - The Lessons Retro section gave two rules that disagreed for `Seen`. `#2812` replaced them at `bd139f5a`: `Seen` is a cumulative event count, a merge of one series keeps the maximum, and `Missed by` accepts `unknown`. No check reads these rules yet.
  - A documentation-only diff selects no build, test or check job, and `Required / CI` accepts the skipped results (`.github/workflows/ci.yml`); a Markdown-only PR therefore cannot fail a ledger check today.
  - `AGENTS.md` line 32 and `CLAUDE.md` line 32 hold the budget caps and the measure command as prose. No job runs them.
  - `WORKFLOW_POLICY_KEYS` in `src/core/workflow/policy-schema.ts` has no `rules` key. Initialization can remove an unknown key.
  - `identityBytes()` in `src/effects/publication/merge-readiness.ts` removes the PR body, so a readiness verdict does not cover the exception text.
  - The check after readiness in `src/effects/publication/merge-executor.ts` covers the PR state, the head and the base only.
  - `SubjectIdentity` in `src/core/evidence/types.ts` has three kinds: contract, review-admission and eval-catalog.
  - The evidence event log lives inside each worktree (`src/effects/evidence/paths.ts`). A log that a CI runner writes does not reach the merge check.
  - CI starts on `opened` and `synchronize`. An edit of the PR body starts nothing.
- [UNVERIFIED]: The cost of one `LedgerEnforcement` run on a PR that changes the ledger. The check reads one file and the PR diff; the measure waits for the implementation.
- [UNKNOWN]: Whether a policy read failure can be told apart from a missing `rules` key on every caller path. `#2816` decides the result class for it.

## Users

### Primary Users

- User: the maintainer who merges and reads the ledger.
  - Need: a violation that names the entry, the field and the fix, and a merge state that no stale result can satisfy.
  - Success signal: a PR that breaks the ledger contract, or that is over the budget without a valid exception, does not merge.
- User: the agent that writes a ledger entry or opens a PR.
  - Need: the same failure message on the local run and in CI, with the field to change.
  - Success signal: the agent repairs the entry from the check output without a question to the maintainer.

### Secondary Users

- User: the maintenance triage job and the human summary.
  - Need: the ledger fields in one parser, and a result view that keeps the original numbers.
  - Success signal: the triage lists exactly the themes that depend on judgment; the summary shows a valid exception as an exception.

## Success Criteria

| Metric | Target | Measurement Method | Degradation Threshold |
|---|---:|---|---:|
| Ledger contract violations that reach main | 0 | A ledger violation in a PR head makes `Required / CI` fail | 1 in a release window |
| Over-budget PRs without a valid exception that merge through repo-harness | 0 | Merge readiness refuses the result | 1 in a release window |
| Rules with two parsers | 0 | One parser for the ledger, one for the exception section | 1 |
| Budget cap locations | 1 | `grep` for the caps and the measure command | 2 |

## Acceptance Scenarios

### Scenario 1: ledger violation fails a Markdown-only PR

- Given: a PR changes `tasks/lessons.md` and no other file, and one entry has an `Enforced by` path that does not exist.
- When: the CI run of that head finishes.
- Then: `Required / CI` fails and the failure names the entry, the field and the fix.
- Machine-checkable evidence: the lane result of `bash scripts/check-ci.sh affected --base <base>` and the `Required / CI` job result.

### Scenario 2: a valid test-budget exception passes

- Given: a PR is over a budget cap, and its body has a `Test budget exception` section with the real counts and a reason.
- When: the rule runs on that head and body.
- Then: the result is a pass, and it keeps the original counts and the exception numbers.
- Machine-checkable evidence: the rule result record and the summary projection of it.

### Scenario 3: the migrated ledger passes

- Given: the 16 entries carry `Name`, `Enforced by`, `Missed by` and a cumulative `Seen`, with each `Enforced by` reference resolving.
- When: `LedgerEnforcement` runs on that head.
- Then: the result is a pass, and triage lists exactly the themes with `Seen` of 3 or more and `Enforced by: judgment`.
- Machine-checkable evidence: the lane result and the `--json` output of `rh run maintenance-triage`.

### Scenario 4 (negative): no silent pass

- Given: a rule check fails to read its input, or the policy read fails.
- When: the result is produced.
- Then (must NOT): the result is never `pass`, and never `off`.
- Machine-checkable evidence: one test per rule that gives a read error and expects `error`; the merge readiness refusal code.

### Scenario 5 (negative): an exception is not a violation fix

- Given: a PR is over the budget and its exception section has an empty heading or wrong numbers.
- When: merge readiness reads the result.
- Then (must NOT): readiness accepts the old green result, and the summary never shows zero violations.
- Machine-checkable evidence: the merge-readiness test for a changed exception; the projection test for the exception state.

### Scenario 6 (negative): a stale result is refused

- Given: a `TestBudget` pass exists for a head, and then the exception numbers, the threshold at the live tip, or the head changes.
- When: merge readiness reads the result.
- Then (must NOT): readiness accepts the result.
- Machine-checkable evidence: the invalidation cases of `#2818`.

### Scenario 7 (negative): the caps keep one home

- Given: `#2819` has merged.
- When: a reader searches the root instruction files for the caps and the measure command.
- Then (must NOT): a second copy exists in the root files or in this PRD.
- Machine-checkable evidence: `grep` over `AGENTS.md` and `CLAUDE.md`.

## Non-goals

- Edit-time content hints on a write. They stay a later trial; see `## Later Scope`.
- Cross-repository rule productization. It stays a later scope; see `## Later Scope`.
- A comment-count rule. It has no repair action.
- The Stop hook as a rule trigger in the first version.
- A guard on merges from the GitHub web page.
- A second lessons file or a second ledger parser.
- A check of the whole ledger history on each run.

## Rule Contracts

### Rule ids

`LedgerEnforcement` and `TestBudget`. The registry, `policy.json`, the ledger and each result use this spelling. The guard-name pattern in `hook-usage` does not change.

### `LedgerEnforcement` decision table

| Condition | Result |
|---|---|
| A required field is missing, an enum value is invalid, or `Seen` is not a positive integer | fail |
| The cumulative count of a theme breaks the counting contract | fail |
| The path or rule id in `Enforced by` does not exist | fail |
| `Seen` of 3 or more, `Enforced by: judgment`, and no `Promoted` | fail |
| A merged entry lost its original correction references and keeps only the consolidation reference | fail |
| The reference exists, but coverage of the whole mistake class is not proved | human review; the check does not report it as verified |

Input: the ledger of the candidate tree, and the change of this PR. Not the full ledger history. Each failure names the entry, the field and the fix.

`Promoted` gets a format check only. A reviewer decides whether the root file states the rule correctly; the check does not match root-file text.

### `TestBudget` result contract

The contract is [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md). It owns the result schema, the producer workflow, the one store, the read path, the bound inputs and each invalidation rule, the error handling, and the scope of the guarantee. This PRD does not restate it. When the two disagree, the ADR is authority for the `TestBudget` contract and this file is authority for the goal and the acceptance conditions.

The acceptance condition that this PRD keeps: the original over-budget numbers stay in every result, and an exception never turns a violation into `no violation`.

### Producers, storage and consumers

| Rule | Producer | Storage and transport | Consumers |
|---|---|---|---|
| `LedgerEnforcement` | `scripts/check-ci.sh` work, from a check script | the CI job log and the lane exit state; `Required / CI` reads the job result | `Required / CI` |
| `TestBudget` | the `Test budget` workflow of ADR-0004, which runs the rule through `rh` | the Actions check run annotation, and no second store | merge readiness (`#2818`), the human summary (`#2820`) |

### Policy

- `rules` is a key of `WORKFLOW_POLICY_KEYS`, with the `TestBudget` switch and its parameters.
- The parameters of a check come from the base configuration, not from the PR change.
- `policy.json` accepts no rule written as a regular expression.
- A policy read failure is not `off by default`. ADR-0004 fixes the result for that case and for a missing configuration.
- The caps live in the root instruction files today. `#2819` moves them into the effective rule configuration and leaves one entry line that names where the enabled rules are. This PRD links [AGENTS.md § Testing](../../AGENTS.md#testing) and does not restate the numbers.

## Module Behaviors (P0)

### Ledger data contract

- Purpose: each ledger entry states its rule, its enforcer and the layer that missed it.
- Hard Constraints: the field set and the counting rule belong to the [Lessons Retro specification](../reference-configs/agentic-development-flow.md#lessons-retro), which `#2812` set. The ledger is the only lessons file.
- Recommended Defaults: `Seen` is a cumulative event count. A merge of one cumulative series keeps the maximum, not the sum. `Missed by: unknown` means the evidence does not show the missed layer; `none` means no layer applies, and this was checked.
- Freedoms: the wording of each entry, subject to the specification.
- Normal path: a repeat copies `Name` and `Mistake pattern` and adds 1 to the last valid cumulative `Seen`. A change of format, classification or enforcement adds nothing.
- Failure path 1: an entry names `judgment` at `Seen` 3 or more and has no `Promoted`; the check fails and names the promotion PR to add.
- Failure path 2: an entry keeps only the consolidation reference; the check fails and names the lost references.
- Merge path: a merge of different themes is a reclassification, and a person checks the events for overlap. A history migration sets the start value from the history evidence, not from the number of references.
- States: `Enforced by` is a path, a rule id or `judgment`. `Missed by` is `self-verify`, `ci`, `independent-review`, `human`, `none` or `unknown`.
- Dependencies: the specification text of `#2812`; the migration of `#2813`.
- Open decisions: None.

### `LedgerEnforcement` check

- Purpose: a broken ledger contract fails the required check, also on a Markdown-only PR.
- Hard Constraints: a check error is not a pass. The check stops at human review; it does not report a coverage gap as verified.
- Recommended Defaults: one parser for the ledger, imported by the check and by triage.
- Freedoms: the check script name and the message text.
- Normal path: the ledger is valid; the check reports the number of entries checked.
- Failure path 1: a required field is missing; the message names the entry, the field and the fix.
- Failure path 2: the check cannot read the ledger or the policy; the result is an error, not a pass.
- States: `pass`, `violation`, `error`, `skipped`, `human review`.
- Dependencies: the ledger contract of `#2812` and `#2813`; the CI wiring shared with `#2817`.
- Open decisions: None.

### `TestBudget` rule

- Purpose: a PR over the budget fails unless its body has a valid exception.
- Hard Constraints: the caps come from the effective rule configuration. This PRD does not restate the numbers. The measure runs from the merge base to the head.
- Recommended Defaults: an empty heading, a quoted template or an example in a code block does not count as an exception. One parser reads the exception section; readiness and the summary reuse it.
- Freedoms: the repair hint text and the internal module layout.
- Normal path: the PR is inside the caps; the result is a pass with the counts.
- Failure path 1: the PR is over a cap; the result is a violation with the counts and the repair hint.
- Failure path 2: the exception numbers do not match the diff; the result is a violation, and the message names the real numbers.
- States: the ADR-0004 schema. This PRD adds no state.
- Dependencies: [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) for the schema, the diff edge cases and the producer.
- Open decisions: None.

### Merge readiness consumer

- Purpose: a merge through repo-harness cannot use a `TestBudget` pass that no longer matches the PR.
- Hard Constraints: fail closed. Every blocker of ADR-0004 is a refusal; none is a pass.
- Recommended Defaults: the comparison uses the parsed exception, not the whole PR body.
- Freedoms: the message text.
- Normal path: each bound input matches; readiness accepts the result.
- Failure path 1: the exception changed; readiness refuses and asks for a new check.
- Failure path 2: the effective configuration at the live tip differs from the result; readiness refuses.
- States: the blocker codes and their meanings are ADR-0004's. This PRD adds no blocker.
- Dependencies: [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) for the read path, the bound inputs and the final check.
- Open decisions: None.

### Human summary

- Purpose: a person sees the rule state with the original numbers.
- Hard Constraints: the summary is a projection and holds no state. Zero violations is not a successful check. An exception is never shown as no violation.
- Recommended Defaults: three distinct cases for rule off, no configuration and invalid configuration.
- Freedoms: the surface and its optional checkpoint view.
- Normal path: the summary shows the check state, the counts and the exception state.
- Failure path 1: no result; the summary shows `no result`, not a pass.
- Failure path 2: the result is an error; the summary shows the error and the repair hint.
- States: `pass`, `violation`, `error`, `skipped`, `no result`.
- Dependencies: `#2817` for the structured result.
- Open decisions: None.

## Data Model

```jsonc
{
  "version": "1",
  "entities": [
    {
      "id": "rule_result",
      "owner": "ci",
      "note": "TestBudget uses repo-harness/test-budget-result/v1 in ADR-0004. LedgerEnforcement reports through the lane result.",
      "fields": {
        "rule_id": "LedgerEnforcement | TestBudget",
        "state": "pass | violation | error | skipped",
        "findings": ["entry, field and fix per failure"]
      }
    },
    {
      "id": "lessons_entry",
      "owner": "maintainer",
      "fields": {
        "date": "YYYY-MM-DD",
        "name": "string",
        "mistake_pattern": "stable theme key",
        "prevention_rule": "string",
        "enforced_by": "path | rule id | judgment",
        "missed_by": "self-verify | ci | independent-review | human | none | unknown",
        "why": "string",
        "triggered_by_correction": ["commit, PR or issue"],
        "seen": "positive integer, cumulative",
        "promoted": "PR | absent"
      }
    }
  ],
  "relationships": [
    { "from": "rule_result", "to": "lessons_entry", "kind": "findings name entries" }
  ]
}
```

The field names of `lessons_entry` come from the Lessons Retro specification. This table repeats them for reading only; the specification owns them.

The `TestBudget` result schema is `repo-harness/test-budget-result/v1` in [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md). This table does not copy it.

The `LedgerEnforcement` output has no document: its findings are the lane failure text, and `Required / CI` reads the job result. A second result store would be a second authority for the same rule.

## Performance Targets

| Target | Number | Measurement Method | Degradation Threshold |
|---|---:|---|---:|
| A rule check on a Markdown-only PR | Under 60 seconds | The job duration in CI | 3 minutes |
| A rule check after a PR body edit | Under 60 seconds, with no test run | The job duration in CI | 3 minutes |
| Ledger parser runs per check | 1 | The check source | 2 |

## Known Unknowns

| Item | Impact | Resolution Path | Owner |
|---|---|---|---|
| The result transport from a CI runner to a local merge check | Merge readiness cannot read a result without it | Decided in [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md): the Actions check run annotation | `#2816` (merged) |
| A `SubjectIdentity` kind for a rule result | A fourth kind would be a second identity authority | Decided in [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md): no kind is reused or added | `#2816` (merged) |
| The ledger entry count after the migration | The `Seen` values of ten entries need history evidence | `#2813` checks the three record stages | `#2813` |
| Whether the `Test budget` context is a required status check | Readiness rejects a missing result only when the check reaches the merge path | Owner adds the context to the branch protection safety net | Owner |

## Developer Handoff

You are implementing this PRD.

- Build first: the ledger migration of `#2813`, then the rule and the workflow of `#2817`. The ledger specification of `#2812` and the result contract of `#2816` are in the base.
- Do not reinterpret: the rule ids, the result states, the bound inputs, the off/no-configuration/invalid-configuration split, and the merge guarantee scope.
- Do not restate the budget caps in a new place. Read them from the effective rule configuration. Do not restate an [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) decision here; link it.
- You may improve: the message text, the repair hints and the internal module layout.
- Verify with: `bun run check:type`; `bun run test:files <affected tests> --timeout 60000 --max-concurrency 1`; `bash scripts/check-ci.sh affected --base <base>`; the negative scenarios of `## Acceptance Scenarios`.

### Child issues

| Order | Issue | Outcome |
|---|---|---|
| 1 | [#2811](https://github.com/aimpact-inc/repo-harness/issues/2811) | this PRD is in `docs/prds` |
| 2 | [#2812](https://github.com/aimpact-inc/repo-harness/issues/2812) | one counting rule for `Seen`; `Missed by: unknown` (merged as #2830) |
| 3 | [#2813](https://github.com/aimpact-inc/repo-harness/issues/2813) | 16 entries carry the Lessons Retro fields with evidence |
| 4 | [#2814](https://github.com/aimpact-inc/repo-harness/issues/2814) | triage lists the themes that still depend on judgment |
| 5 | [#2815](https://github.com/aimpact-inc/repo-harness/issues/2815) | a ledger violation fails `Required / CI`, also on a Markdown-only PR |
| 6 | [#2816](https://github.com/aimpact-inc/repo-harness/issues/2816) | the `TestBudget` result contract is decided in [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) (merged as #2831) |
| 7 | [#2817](https://github.com/aimpact-inc/repo-harness/issues/2817) | CI produces a `TestBudget` result; a valid exception passes |
| 8 | [#2818](https://github.com/aimpact-inc/repo-harness/issues/2818) | merge readiness refuses a stale result |
| 9 | [#2819](https://github.com/aimpact-inc/repo-harness/issues/2819) | the budget caps have one authority |
| 10 | [#2820](https://github.com/aimpact-inc/repo-harness/issues/2820) | a person sees the rule result with its original numbers |

### Acceptance Scripts

1. `bash scripts/check-ci.sh affected --base <base>` on a head with a ledger violation: fail, with the entry, field and fix.
2. The same command on the migrated ledger: pass.
3. `bun run test:files <rule tests> --timeout 60000 --max-concurrency 1` with the over-budget, empty-exception and exception-changed cases.
4. A merge-readiness test for each invalidation input that [ADR-0004](../adr/ADR-0004-test-budget-result-contract.md) binds.

## Later Scope

These items are not in this program. Each one needs its own parent issue and plan.

### Edit-time trial

A rule result at write time is a trial, not part of this contract.
- The Pi adapter sends only `tool_input.file_path` to the mutation guard (`src/cli/hook/mutation-guard.ts`). A content rule has no input there.
- The failure log writer records `action: block` and no rule id.
- The trial starts when an adapter sends the file content and the failure log carries the rule id.

### Cross-repository productization

A rule that adopted repositories can switch on needs a distribution path.
- No ledger entry is proved to meet a cross-repository condition.
- The rule registry in this program holds a stable id, the parameters and a repair hint. Nothing more.

### Not carried

A comment-count rule, a Stop-hook trigger and a guard on merges from the GitHub web page stay out of scope. No evidence supports them yet.
