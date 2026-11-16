---
schemaVersion: archcontext.adr/v1
title: The operator console sends no task inbox message to a rules task seat
status: accepted
decidedAt: 2026-11-16
appliesTo:
  - capability.organization.task-fleet
  - capability.runtime-harness.operator
---

# ADR-0005: The operator console sends no task inbox message to a rules task seat

## Context

The owner decided on 2026-11-16 that the console may send follow-up messages
to the executing seat of a rules task in phase 3 of the rules PRD, after this
check ([#2879](https://github.com/aimpact-inc/repo-harness/issues/2879) decision
5). That decision changes the earlier one, which opens a dialog only to the
advisor.

This ADR answers four questions about the write path at
`main@5dedf0e3d`, and records the decision
([#2883](https://github.com/aimpact-inc/repo-harness/issues/2883)).

State at this base:

- `rh fleet message send` requires `--task-id`, `--context <file>` with
  `{admission, claim, session}`, `--scope task|claim`,
  `--audience owner|orchestrator|user` and `--body-file`
  (`src/cli/commands/fleet.ts:316-327`). The context carries the admission
  digest, the claim reference and revision, and the session task and role
  (`src/cli/commands/fleet.ts:69-81`).
- The operator server reads task messages only: `task_messages` is a `GET`
  route (`src/effects/operator/server.ts:158`). The route serves one task that
  the execution view of the same repository lists as `verified`
  (`src/effects/operator/server.ts:1653-1662`).
- The one console write into an agent terminal is the advisor seat
  (`src/effects/operator/server.ts:152-155`).

## Answer 1: no function gets the current admission, claim and session from `repository_id` and the issue number

**No such function exists.** Four gaps block it, and each one is enough.

**1. The admission store is keyed by a campaign, and it cannot be listed.**
`location()` builds the directory from `reviewCampaignKey(identity)`, which
requires `repository_id`, `issue_id` **and** `campaign_id`
(`src/effects/admission/admission-store.ts:36-42`,
`src/core/review/authority-context.ts:68-71`). The store has no directory
enumeration: `src/effects/admission/admission-store.ts` calls `readdirSync`
zero times. A caller that does not know the campaign id cannot find the record.
It also needs `expectedGrantSha256`, `expectedPolicySha256` and
`expectedActor`, and it checks all three
(`src/effects/admission/admission-store.ts:135-157`).

**2. `issue_id` is the provider numeric id, not the issue number.**
`observeReviewIssueGoal` compares `issue.provider_issue_id !== input.issue_id`
(`src/effects/admission/issue-goal.ts:24-25`). The issue number is a separate
field, `issue_number` (`src/core/review/authority-context.ts:146`, validated at
`:162`), and it appears in no lookup key. So the input "issue number of a rules
task" does not reach any admission function.

**3. The two `repository_id` values are different identifiers.** The admission
`repository_id` is the GitHub numeric repository id
(`src/effects/admission/issue-goal.ts:24`; CLI text at
`src/cli/commands/seats.ts:307`). The operator route `repository_id` is the
registry id `repo_<16 hex>` (`src/effects/repo-registry.ts:112-114`), resolved
through `readRepoHarnessRegistryStrictSnapshot(...).repos`
(`src/effects/operator/task-messages.ts:24-27`). No function maps one to the
other for an admission lookup.

**4. The session lookup needs a role and a task id, and a rules task has
neither.** `readTaskAgent(repoRoot, task, role)` needs all three arguments
(`src/effects/terminal/task-session-record.ts:168-169`), and its directory is
`sha256(JSON[repository_id, task, role])`
(`src/effects/terminal/task-session-record.ts:103-105`). Nothing indexes an
issue number to a `(task, role)` pair.

A rules task has no admitted session at all. Only the generic review launcher
writes a binding with `task_admission`, and its task id is the campaign key
`campaign.slice(7)` (`src/effects/review/generic-review.ts:86`, `:179`,
`:251`). The only callers of `startTaskAgent` and
`bindTerminalApplicationHost` are that review path
(`src/effects/review-runner/task-review-runner.ts:155-156`); a Herdr worker
seat gets its argv from `rh seats argv`
(`src/cli/commands/seats.ts:304-335`), which writes no task-agent record. A
dispatched rules issue is a worktree plus a seat plus a prompt string
(`src/effects/board/dispatch.ts:44`, `:78-79`, `:94`).

So for a rules task seat: no admission, no claim reference, no task id, and no
function that would produce them.

## Answer 2: only `scope: claim` with `audience: owner` reaches a claim recipient

The one pair that matches the executing seat:

| Field | Value | Evidence |
|---|---|---|
| `scope` | `claim` | `src/core/fleet/admitted-task-message.ts:132` |
| `audience` | `owner` (required by the scope) | `src/core/fleet/admitted-task-message.ts:133-135` |
| recipient kind | `claim` | `src/effects/fleet/task-inbox.ts:415-416` |

The audience check is `event.audience === (recipient.kind === 'claim' ? 'owner'
: recipient.kind)` (`src/effects/fleet/task-inbox.ts:415-416`). An event with
`audience: orchestrator` or `audience: user` matches only the recipient kinds
`orchestrator` and `user` (`src/core/fleet/admitted-task-message.ts:35`), which
are not the executing seat.

Two further inputs are required to reach that seat:

- The recipient claim must equal the admitted claim
  (`src/effects/fleet/task-inbox.ts:420`).
- `execution_worktree` must resolve to the admission's `execution_root`
  (`src/effects/fleet/task-inbox.ts:421`). For the generic reviewer that root is
the dedicated linked checkout. For a Herdr worker seat there is no admission to
compare against.

**Nothing renders an inbox event into a worker seat.** The only path that marks
a claim-recipient event delivered and puts its body into a session is
`commitPrePromptInbox` with channel `controlled_request`
(`src/effects/review-runner/task-pre-prompt-inbox.ts:104`), consumed by the OAR
host at `src/effects/review-runner/task-oar-host.ts:176`. That host is the
reviewer. The `UserPromptSubmit` inbox route is bound to `agent-notice`, and
the architecture record states that this adapter prints no message context
(`src/cli/hook/route-registry.ts:105-111`,
`docs/architecture/modules/organization/task-fleet.md:114`). No writer in
`src/` uses channel `hook_session`.

So the console would write an event that no code path delivers to a rules task
seat.

## Answer 3: a replaced claim leaves the message with no recipient

A worker is replaced and the task has a new claim. The old page sends a
message. Three outcomes are possible, and none of them reaches the new claim
holder.

**A. The event was written under the old admission.** Every inbox scan filters
by the caller's exact `admission_sha256` (`isCurrentRevisionEvent`,
`src/effects/fleet/task-inbox.ts:561-563`), so the new holder skips it
(`:619`, `:693`) and the scan counts it in `superseded_revision_count`
(`:633`). **Nobody receives the message.** The page gets no refusal, because
the write succeeded when it was made. `readAdmittedTaskActivity` takes no
revision input (`src/effects/fleet/task-inbox.ts:823-826`) and reads each event
without a revision check (`:855-862`), so the console read still shows the
message, without a marker that no seat can receive it
(`src/effects/operator/task-messages.ts:28`).

**B. The send names the old claim while the admission is current.** The send
refuses `claim_mismatch` (`src/effects/fleet/task-inbox.ts:601`); a delivery or
list refuses `claim_mismatch` at `:420`; an acknowledgement refuses
`claim_mismatch` at `:752`.

**C. The send names a stale admission.** The send refuses
`task_revision_mismatch` (`src/effects/fleet/task-inbox.ts:599-600`). A read or
acknowledgement of one exact message refuses `task_revision_mismatch` at
`:551`. A wrong worktree refuses `recipient_unavailable` at `:421`.

Case A is the one an old page reaches, because the page held a valid context
when it loaded. The new claim holder receives nothing, and the old page gets
no error. That silence is the decisive gap.

## Answer 4: created, delivered and read are three different proofs

A successful send proves the least of the three.

| State | Record that proves it | Evidence |
|---|---|---|
| Event created | `.../admitted/events/<message_id>.json`, written by hard link and followed by a directory fsync | `src/effects/fleet/task-inbox.ts:441-482` |
| Delivered | `.../admitted/delivery/<message_id>/<recipient-key>.json` with `delivery_state: delivered` and a non-null `delivered_at` | `src/effects/fleet/task-inbox.ts:508-540`; `src/core/fleet/admitted-task-message.ts:322` |
| Read by the agent | the same receipt with `delivery_state: acknowledged` and a non-null `acknowledged_at` | `src/effects/fleet/task-inbox.ts:740-763`; `src/core/fleet/admitted-task-message.ts:323` |

`sendTaskMessage` returns `{event, event_path, created}`
(`src/effects/fleet/task-inbox.ts:141-145`). That is state one only. A
delivered receipt means the inbox marked the event. It does not mean an agent
read it: `deliverTaskInbox` writes the receipt before it returns the body
(`src/effects/fleet/task-inbox.ts:721-726`).

**The only strong read proof is the controlled request.** For channel
`controlled_request` the receipt carries `delivery_ref`
`controlled-request:<request_id>:<session_binding_sha256>`
(`src/effects/review-runner/task-pre-prompt-inbox.ts:101`), and it is written
only from an OAR input-scoped accepted observation
(`src/effects/review-runner/task-pre-prompt-inbox-consumer.ts:69-72`). No
worker seat has that host.

So a console write with channel `manual` could prove created and delivered, and
never read.

## Decision

**No-go.** The console adds no task inbox write. A follow-up message to the
seat of a rules task is an issue comment, as it is today.

Reason: the four answers above block a correct write route.

1. The console cannot obtain the inputs the existing send requires. There is no
   function from `repository_id` and issue number to an admission, a claim or a
   session (Answer 1).
2. A rules task seat has no admitted task session, no claim reference and no
   task id, because only the generic review launcher creates one (Answer 1).
3. Nothing in `src/` renders an inbox event into a worker seat. The
   `UserPromptSubmit` adapter prints no message context, and the only body
   consumer is the reviewer's OAR host (Answer 2).
4. A replaced claim leaves a sent message with no recipient and no error to the
   sender (Answer 3). A console page would report success for a message that no
   agent can receive.

A `go` would therefore need four new mechanisms, not a new route: an index from
an issue to its admitted session, an admission lookup that does not need a
campaign id, a delivery path into a worker seat, and a delivery proof that
survives a claim change. This issue names none of them, so this ADR does not
propose them.

Answer 4 sets the bar for any later proposal: a page may claim delivery only
from a receipt that carries a bounded control reference, not from
`created: true` and not from `delivery_state: delivered` alone.

## Consequences

- Phase 3 of the rules PRD starts without a task inbox write. The conversation
  view at level G3 shows messages only if a write path exists later.
- The console keeps one write into an agent terminal, the advisor seat
  (`src/effects/operator/server.ts:152-155`).
- The gap in Answer 3 is a present defect of the read path, independent of the
  console: the operator task message view shows superseded-revision messages
  with no marker (`src/effects/fleet/task-inbox.ts:823-826`,
  `src/effects/operator/task-messages.ts:28`). A later page that shows messages
  needs that marker. This ADR records it and changes nothing.
- Rollback: delete this file. The ADR changes no behavior.
