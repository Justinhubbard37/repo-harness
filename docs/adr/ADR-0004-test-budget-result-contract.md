---
schemaVersion: archcontext.adr/v1
title: Test budget result contract
status: proposed
decidedAt: 2026-11-16
appliesTo:
  - capability.organization.publication
  - capability.runtime-harness.evidence-ledger
---

# ADR-0004: Test budget result contract

## Context

The `TestBudget` rule limits the test lines and the test files that a PR adds.
A PR over budget needs a valid `Test budget exception` section in its body.
[#2817](https://github.com/aimpact-inc/repo-harness/issues/2817) implements the
producer. [#2818](https://github.com/aimpact-inc/repo-harness/issues/2818)
implements the consumer. This ADR fixes the contract between them
([#2816](https://github.com/aimpact-inc/repo-harness/issues/2816)).

State on main at cc7cf86:

- `identityBytes()` in `src/effects/publication/merge-readiness.ts` removes the
  PR body from the PR identity. An edit of the exception does not change it.
- After readiness, `prepareMerge()` in `src/effects/publication/merge-executor.ts`
  re-reads the PR state, head and base only.
- `SubjectIdentity` in `src/core/evidence/types.ts` has three kinds: contract,
  review-admission and eval-catalog. Each kind needs fields that a rule check
  does not own (`contract_hash`; or campaign, admission and grant digests; or
  catalog and eval digests).
- The evidence event log is per worktree and gitignored
  (`.ai/harness/evidence/events/log.jsonl`). A log that a CI runner writes does
  not reach a local seat or the merge check.
- `ci.yml` starts on `opened` and `synchronize`. An edit of the PR body starts
  nothing.
- Readiness already reads each required Actions check for the PR: the run
  (bound to PR, head and base), the attempt jobs and steps, and the job
  annotations.

## Decision

### Producer

A new workflow `.github/workflows/test-budget.yml` with one job `Test budget`
runs the rule through `rh`. It starts on `pull_request` types `opened`,
`synchronize` and `edited`, and has its own concurrency group per PR. It is not
a job of `ci.yml`: an `edited` run in the `ci.yml` group would cancel a running
full CI.

The job computes one result document (below), prints it, and ends with the
conclusion that the state maps to:

| State | Job conclusion |
|---|---|
| `pass` | success |
| `skipped` | success |
| `violation` | failure |
| `error` | failure |

Without an exception, `violation` fails the job. With a valid exception the rule
result is `pass` (see `exception`). A `violation` that the job reports as
failure is a signal for the PR author; the merge decision uses the document, not
the conclusion alone.

The `edited` trigger only refreshes the result. Correctness does not depend on
it: the consumer recomputes the live inputs (see Consumer) and rejects a result
that does not match them.

### Result schema `repo-harness/test-budget-result/v1`

```json
{
  "schema": "repo-harness/test-budget-result/v1",
  "state": "pass | violation | error | skipped",
  "bound": {
    "head_sha": "<40 hex>",
    "diff_start": "<40 hex merge-base of base and head>",
    "policy_digest": "<sha256 of the effective rule configuration>",
    "implementation_version": "<test-budget rule version integer>",
    "exception_digest": "<sha256 of the parsed exception, or null>"
  },
  "measured": {
    "added_test_lines": 0,
    "added_product_lines": 0,
    "added_test_files": 0,
    "ratio": 0,
    "ratio_cap": 2,
    "file_cap": 1
  },
  "over_budget": false,
  "exception": {
    "present": false,
    "valid": false,
    "counts": null,
    "reason": null
  },
  "error": null
}
```

- `state` is `pass` when the PR is within budget, or when it is over budget and
  the exception is valid ("check complete; over budget; exception valid; pass
  allowed"). It is `violation` when the PR is over budget and the exception is
  missing or invalid. It is `error` when the rule could not complete (see Error
  handling). It is `skipped` only when the effective configuration disables the
  rule.
- `measured` and `over_budget` always carry the original numbers. A valid
  exception does not rewrite them.
- `exception.counts` holds the numbers that the section states. The rule
  checks them against `measured`. A mismatch makes the exception invalid.
- `error` is `null`, or `{ "code": string, "message": string }` when `state` is
  `error`. An `error` result carries no `measured` values.
- `measured.ratio_cap` and `measured.file_cap` come from the effective
  configuration, not from constants in the consumer.

### Bound inputs

| Field | Use | Makes the result invalid when |
|---|---|---|
| `head_sha` | the reviewed commit | the PR head differs from it |
| `diff_start` | start of the diff; the `main...HEAD` meaning (merge-base of the live base and the head) | the merge-base the consumer computes differs from it |
| `policy_digest` | switch and parameters | the digest of the effective configuration of this rule at the live base tip differs. A change of another file or another policy key does not change it |
| `implementation_version` | which rule version ran | it differs from the version in the running `rh` |
| `exception_digest` | numbers, reason and presence of a valid section | the digest of the exception parsed from the live PR body differs. A change of other PR text does not change it |

`policy_digest` is the digest of the parsed, canonical effective configuration
(switch and parameters after defaults), not the blob SHA of the policy file. A
blob SHA changes for every edit of `.ai/harness/policy.json`, including keys
that belong to other rules.

`exception_digest` is the digest of the canonical parse of the
`Test budget exception` section (counts and reason). It is `null` when the PR
has no such section.

### Storage and read path

The result is not an evidence event. The evidence log is per worktree and a CI
runner cannot reach it from a local seat. The Actions check run of the
`Test budget` job on the PR head is the single store. No file, artifact or
second ledger holds a copy.

The job writes the document as one check annotation of level `notice`, with
title `repo-harness/test-budget-result/v1` and the JSON as the message. A
passing job still carries it.

The consumer reads it through the path that readiness already uses for a
required check: `pr checks --required`, the Actions run bound to PR, head and
base, the attempt jobs, then the annotations of the job's check run. Work that
the two implementation issues own:

1. #2817: the workflow, the rule, the parsed exception, the annotation writer.
2. #2818: a strict annotation read in readiness. Today the annotation read is
   best effort (`optional`) and serves failure excerpts. For this rule a missing,
   unreadable or duplicated result annotation blocks the merge.
3. Owner item: add the `Test budget` context to the required status checks of
   branch protection. This is a safety-net change and stays with the owner.

When several runs exist for the head (opened, synchronize and edited runs), the
consumer takes the newest completed attempt of the `Test budget` workflow for
this PR head and base. It validates that run through the existing binding
(`requiredCheckRunFacts`).

### Consumer

The consumer is `collectPullRequestMergeReadiness` in
`src/effects/publication/merge-readiness.ts`. It runs in the merge path before
any merge request. It:

1. Reads the result as above.
2. Recomputes the five bound inputs from live state: the PR head, the
   merge-base, the effective configuration at the live base tip (the policy read
   that `readGatingPolicy` already does), its own rule version, and the
   exception parsed from the live PR body. The PR body is read in the same
   observation as the other readiness reads.
3. Blocks with `test_budget_stale` when any bound input differs, with
   `test_budget_missing` when no valid result exists, and with
   `test_budget_violation` or `test_budget_error` for those states.
4. Passes when the state is `pass`, or `skipped` with `policy_digest` equal to
   the live digest.

`identityBytes()` keeps removing the body. The exception digest is a separate
bound input; adding the whole body to the identity would block the merge for any
edit of other PR text.

After readiness, `prepareMerge()` re-reads the PR through `readMergeTarget()`,
which returns the live `target.body`. The readiness verdict carries the
validated `exception_digest`. `prepareMerge()` parses the exception from
`target.body`, recomputes the digest and compares it with the validated one.
On a difference it refuses with `test_budget_stale` and the caller re-runs
readiness. A change of other body text keeps the digests equal and the merge
continues. The final check also covers the head and the merge-base, which it
already compares for head and base.

One window remains: a body edit after that final read and before the provider
accepts the merge request. The merge request cannot bind the body, so the first
version accepts this smaller window.

Regression in the public merge path with a provider fixture: the first read has
exception E, the final read removes or changes E, head and base stay equal, and
no merge request is sent. A final read that changes only unrelated body text
still merges.

### SubjectIdentity

A rule check uses none of the three `SubjectIdentity` kinds. Each kind needs
authority fields that this rule does not have (`contract_hash`, review grant
digests or an eval catalog digest). A fourth kind would add a type for one
producer whose result never enters the evidence log. The result document has its
own schema and `bound` object. No `SubjectIdentity` field is reused or invented.

### Error handling

- A policy read failure (provider outage, unreadable file, invalid JSON, invalid
  rule keys) gives `state: "error"` with a code. It never gives `skipped` and is
  never treated as the rule being off.
- A policy file that exists and parses, and has no configuration for this rule,
  means the rule is disabled: `state: "skipped"` with the digest of the empty
  configuration. The consumer accepts `skipped` only when its own read at the
  live tip gives the same digest. A repository that enables the rule later
  invalidates the old `skipped` result through `policy_digest`.
- A 404 for the policy file is a missing file, not an outage; it is the same as
  "no configuration for this rule".
- A diff that cannot be computed (no merge-base, shallow history) gives `error`.
- An exception section that cannot be parsed gives `violation` when the PR is
  over budget, and has no effect when it is within budget.

### Scope of the guarantee

The guarantee covers the repo-harness merge path (`rh` publication merge). A
merge from the GitHub web page, or any path that skips readiness, is outside the
first version.

## Consequences

- One store (the check run), one producer (the workflow), one consumer
  (readiness). The evidence ledger gains no event type.
- A change to the PR body starts a new, cheap run and also invalidates the old
  result by digest, so a stale pass cannot carry an edited exception.
- At 10x PR volume the first limit is the annotation read per merge: one extra
  `gh` call per readiness. The check-run API bounds it.
- The body-edit window between the final read and the merge request remains.
- Rollback: delete the workflow and the consumer check; `git revert` of the
  implementation commits. The ADR changes no behavior.
