# Design Brief: Rules workspace of the operator console

> **Status**: Draft. Approval is a `Joint decision (orchestrator + advisor)` comment on [#2884](https://github.com/aimpact-inc/repo-harness/issues/2884) (gap review F10). #2886 and #2890 start after that comment.
> **Slug**: rules-review
> **Owner**: Ancienttwo
> **Date**: 2026-11-16
> **Issue**: [#2884](https://github.com/aimpact-inc/repo-harness/issues/2884), parent [#2879](https://github.com/aimpact-inc/repo-harness/issues/2879)

## Inputs and authority

The authority chain of `docs/reference-configs/ux-feature-guard.md` applies: owner decisions and the PRD own the intent; this brief makes them concrete and changes none of them. Where an input disagrees with a child issue or the code, the conflict is listed in [Document issues](#document-issues).

| Input | Version | Use |
| --- | --- | --- |
| PRD draft "repo-harness 规则审阅与管理" | [Claude artifact](https://claude.ai/artifact/Dhpu35HJfapULWXqDcfkDa), rev 22, read 2026-11-16 | Product intent: section 页面 (four surfaces, status words, page per state), 写入与权限边界, 跨系统恢复. #2880 lands the English copy in `docs/prds/` |
| Owner decisions 1-10 | [#2879](https://github.com/aimpact-inc/repo-harness/issues/2879) body, "Decisions" | Decisions 3 (routing class, not seat), 4 (waiting for orchestration, copy prompt), 7 (`enforce` from `Seen` 2, offered first), 9 (group `observe`) |
| Gap review | [#2879 comment](https://github.com/aimpact-inc/repo-harness/issues/2879#issuecomment-6918866248) rows F3, F4, F5, F10 (this issue), F6 and F9 (data this brief renders) | Eight `progress` values; approval route; evidence errors keep the candidates |
| Security bar | [#2879 comment](https://github.com/aimpact-inc/repo-harness/issues/2879#issuecomment-6918953981) | I1 no credential leak, I2 no unauthorized delete or overwrite. The brief adds no other guard |
| Data contracts | #2882 (`rh rules status`), #2885 (route and unavailable reasons), #2887 (refusal codes, result document), #2888 (`task`, `orchestration`), #2889 (`routes`, `herdr`, write routes) | Every field and code that a surface shows |
| Console brief | [`DESIGN-operator-console-uiux.md`](DESIGN-operator-console-uiux.md), confirmed 2026-10-27 | Shell, colors, type, layout, motion, anti-patterns. This brief inherits them and adds no visual language |
| Design system | [`docs/design/operator-console/design-system/`](../design/operator-console/design-system/README.md) | SegmentedTabs, StatusBadge, CommandCopy, SourceBanner, ListGroup |
| Code baseline | `main@6501c27e8` (descendant of `2b758d771`, gap review F4) | File and line references below |

## Purpose & Audience

- Page/surface: the workspace `rules` in the navigation group `observe` of `rh operator serve`, for the selected repository. Four surfaces: the Rules page, the candidate drawer, the rules task view, and All repositories (phase 4, sketch only).
- Primary audience: the owner of the repository, who reviews the lessons ledger and decides which mistake class gets a machine check or a root rule.
- Job to be done: see which ledger themes are promotion candidates and why, file one promotion task with an edited prompt, and follow that task until the owner gives GO in a terminal. Today `rh run maintenance-triage` lists the ten themes in a terminal only, and a promotion starts by hand.

## Surfaces and phases

| Surface | Phase | Child | Entry | Location (hash) |
| --- | --- | --- | --- | --- |
| Rules page, segment Candidates | 1 | #2886 | Side rail, group Observe, after Tests | `#rules` |
| Rules page, segment Ledger | 1 | #2886 | Segment control; link from the no-candidate state | `#rules/ledger` |
| Candidate drawer | 2 | #2890 | Click on a candidate row | `#rules/candidate/<candidate_id>` |
| Rules task view | 2 | #2890 | The Task section of the candidate drawer when the action has a task | same as the drawer |
| Rules page, segment Enabled rules | 3 | not filed | Segment control | `#rules/enabled` |
| All repositories | 4 | not filed | Segment control | `#rules/all` |

A surface appears in the side rail, the segment control and the router only in its phase. No placeholder segment and no disabled entry (console brief, anti-pattern "placeholder page").

## UX Feature Guard

- Requested outcome: a person reads the promotion candidates of the selected repository and the full ledger without a terminal (phase 1); files one promotion task per candidate through the existing orchestration and follows it (phase 2).
- Frozen behavior / rules that must not change:
  - Governance comes only from the ledger; task progress comes only from GitHub. The page shows both and derives neither from the other (#2888 invariant). A merged PR does not change governance.
  - Candidate rules (#2882): `enforce` is open for a `judgment` theme with `Seen >= 2`; `promote_root` for a `judgment` theme with `Seen >= 3` and no `Promoted`. The page computes no candidate; it renders `themes[].actions` of the snapshot.
  - The console dispatches nothing, posts no claim, merges nothing, gives no GO, and writes no ledger, policy, rule source or root instruction file (#2879 Done when; PRD 控制台不做的事).
  - The user selects a routing class, never a seat. The expected seat is an estimate (owner decision 3).
  - The write channel does not replay a request whose result is not recorded (`reconcile_required`). The page never retries on a timer.
- Requested action: phase 1 none. Phase 2: `rules_promote` (file one task) and `rules_reconcile` (complete a half-finished filing). Both are `POST` routes of #2889 through `postOperatorWrite`.
- Exact payload acted on: `rules_promote` sends `{request_id, candidate_id, route, ledger_blob, prompt}`. `prompt` is the edited text plus the unchanged marker line. `ledger_blob` is `status.ledger.blob` of the snapshot on screen. `request_id` is new for each click of Submit. `rules_reconcile` sends `{request_id, candidate_id}`. The page adds no other field.
- Forbidden extras / non-goals: a seat picker; a dispatch, merge or GO button; any edit of `tasks/lessons.md`; a retry timer; a conversation with the executing seat (phase 3); Home counts (out of scope of #2890); a page-side candidate rule or a page-side block of the second action of a theme (see Document issues D3).

### Role-aware User-visible Concept Boundary

- Audience / role for this surface: the repository owner on the local console. One role.
- Allowed visible concepts: theme key, theme text and name; `Seen`; `Enforced by` (the value `judgment` or a repository-relative file path); `Promoted`; ledger line numbers; the ledger path `tasks/lessons.md`, short head SHA and the dirty flag; field errors (line, field, value, fix) and evidence errors (theme, `Triggered by correction`); lesson fields and correction source links (F6); the enforcement ladder; the prefilled and edited prompt; the candidate marker line; the five routing classes with the expected seat id, runtime and model; issue and PR numbers and links; the claim seat id; the rules parent number; refusal codes with the server `message` and `next_action`; the `rh publication merge` command text.
- Required outcome/recovery concepts that must stay visible: why the ledger is invalid and on which line; which reason makes the page unavailable; that a submit result is not confirmed and an issue may exist; the Reconcile control; the existing issue on `candidate_open`; what orchestration is missing (plan comment, coordinator claim, rules parent).
- Backstage-only concepts that must never appear as user-visible: `candidate_id` hex (only in the URL and in the marker line, which is part of the prompt payload); `request_id`; `prompt_sha256`; the operator state directory and the prompt file path; absolute paths; stderr and child-process output of the collector or of `rh rules promote`; the `gh` token, the write token and any environment value (I1); the quota numbers behind the expected seat.
- Role-gated exceptions: none.
- Authority for each exception: N/A.

`UX-rules-review-N1` derives from the non-goals above: no dispatch, merge, GO or seat control exists, and no backstage-only value is rendered.

### Authority & Reuse Map

| Responsibility / datum | Existing authority or reuse target | Decision | New-surface justification |
| --- | --- | --- | --- |
| Side-rail entry and group | `WORKSPACES` (`src/operator-web/workspace-location.ts:10-25`), `nav.group.observe` (`src/operator-web/i18n/shell.ts:73`) | extend: `{ id: 'rules', group: 'observe' }` after `tests` | — |
| Hash location of segment and drawer | `parseWorkspaceLocation` / `workspaceHash` (`workspace-location.ts:113`, `:145`), `item` field | extend: `item` is `null`, `ledger`, `candidate/<id>` (later `enabled`, `all`) | — |
| Read-only page skeleton: header, boundary line, loading, refusal | `TestsPage` (`src/operator-web/TestsPage.tsx:229-260`, `TestsRefusal` and `TestsPage`) | reuse the pattern | — |
| Snapshot and unavailable reasons | `src/core/operator/rules.ts` of #2885 (strict decoder shared with the server) | consume | — |
| Segment control | SegmentedTabs (design system); the tablist of `ViewTabs` (`src/operator-web/ArchitectureWorkspace.tsx:269-289`) | reuse; segments change the URL, so each segment is `<a aria-current>` per SegmentedTabs | — |
| Status dot and pill | `StatusDot` and `DotTone` (`src/operator-web/ui.tsx:8-29`); Kumo `Badge` | reuse | — |
| Section titles and counts | `SectionTitle` (`ui.tsx:104`) | reuse | — |
| Ledger invalid and source failures | Kumo `Banner` as SourceBanner (`operator-write.tsx:45` is an existing use) | reuse | — |
| Empty state | `BoardState` (`ui.tsx:114`) | reuse | — |
| Drawer frame and focus | `DrawerFrame`, `useModalFocus` (`src/operator-web/Drawer.tsx:29`, `:95`) | reuse | — |
| Drawer sections and rows | `Section`, `Row` of `TaskDrawer.tsx:20-31` | reuse; move to a shared place only if #2890 needs them outside `TaskDrawer.tsx` | — |
| Prompt editor | the `textarea` of `OfficeAdvisorDialog.tsx:178` and its CSS | reuse the style | — |
| Copy prompt, copy GO command | `CopyButton`, `CommandLine` (`ui.tsx:48`, `:72`), `copyOperatorIdentifier` (`src/operator-web/clipboard.ts:2`) | reuse | — |
| Write client and failure states | `postOperatorWrite`, `OperatorWriteFailure`, `WriteReloadBanner` (`src/operator-web/operator-write.tsx:12-47`) | reuse | — |
| Ask the advisor | `OfficeAdvisorDialog` (`OfficeAdvisorDialog.tsx:96`) | extend: one prop `initialDraft` (#2890) | — |
| Routing class list and expected seat | `routes` of the snapshot (#2889, from `selectSeatRoute`) | consume; render as a radio list in ListGroup rows | — |
| Copy text | `src/operator-web/i18n/rules.ts` (new, #2886) typed `zh` against `en` | new | One message module per page is the rule of `i18n/index.ts:22-28` |
| Rules page and drawer components | `RulesPage.tsx` (#2886), `RulesCandidateDrawer.tsx` (#2890) | new | No existing page reads the rules snapshot |

### Observable & Copy Contract

- Happy/loading/empty states that can actually occur: loading (first read); ready with candidates; ready with no candidate; ledger invalid by field error (no candidate); ledger with evidence errors only (candidates kept, F9); ledger dirty; page unavailable by one of the six reasons of #2885 plus `unreachable`; drawer with Herdr ready or unavailable; submit in flight, filed, refused, or not confirmed; reconcile in flight, done, or refused.
- Invalid/unavailable state: each state names what happened, where, and the next action. See [States](#states) and [Copy](#copy).
- Machine-readable output contract: the page sends `GET` for the snapshot and `POST` only to `rules_promote` and `rules_reconcile`, with the payloads in the Guard above. No other request.
- Canonical copy source / sync sites: the [Copy](#copy) tables of this brief are the source for `src/operator-web/i18n/rules.ts`. The key names are proposals; the `en` and `zh` texts are approved with this brief. The status words match the PRD section 状态用语.
- Fail-loud rule: a reason, a refusal code or a progress value that the page does not know is shown as its raw code with the server `message`, never as a known state. A failed read shows its reason, never an empty list or `0`. `progress: unknown` shows the hollow dot and "Status unknown", never the last known value.

## Rules page

```text
┌ Rules ─────────────────────────────────────────────────────────────────────────┐
│ Promotion candidates from the lessons ledger. The console files a task;        │
│ it never dispatches, merges or edits the ledger.                               │
│ tasks/lessons.md · head 6501c27 · collected 3 min ago                          │
├────────────────────────────────────────────────────────────────────────────────┤
│ [ Candidates 10 ] [ Ledger 16 ]                                                │
├────────────────────────────────────────────────────────────────────────────────┤
│ (SourceBanner slot: ledger invalid / evidence errors / dirty / Herdr / orch.)  │
├────────────────────────────────────────────────────────────────────────────────┤
│ Theme                          Seen  Governance                  Actions       │
│ worktree-cleanup               7×    (● Judgment · not in root)  Enforce        │
│ Delete only merged worktrees         ─────────────────────────   ○ Not filed    │
│                                                                  Promote to root│
│                                                                  ● Seat working │
│                                                                    · PR #2901   │
│ …                                                                              │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Header: title `nav.rules`; one boundary line (`rules.boundary`); one source line: ledger path, `ledger.head` short (7), and the age of `collected_at` (`Age`, `ui.tsx:32`).
- Segment control: Candidates with the count of themes that have at least one action; Ledger with the count of all themes. Counts come from the snapshot. Enabled rules (phase 3) and All repositories (phase 4) are absent before their phase.
- Banner slot: at most one SourceBanner, below the segments and above the list. Priority when several apply: ledger invalid, then evidence errors, then ledger dirty. Herdr and orchestration notices of phase 2 sit in the drawer, not here.
- No repository selected: `repository.select` (existing key), as on the Tests page.

### Segment Candidates

One row per theme with at least one action, sorted by theme key (the snapshot order).

| Column | Content | Component |
| --- | --- | --- |
| Theme | key (mono) on line 1; `name`, or `theme` text when `name` is null, on line 2 | text |
| Seen | `Seen <n>×` | mono, tabular numbers |
| Governance | one pill (see [Two status groups](#two-status-groups)) | StatusBadge pill |
| Actions | one line per open action, `enforce` first (owner decision 7): action label, then the task progress as dot + text, or "Not filed" when `task` is `null` | StatusDot + text |

- Phase 1 (#2886): rows are not interactive. Phase 2 (#2890): the whole row opens the candidate drawer. There is no button in the row.
- A `merged` task on a theme that still has the action stays in the list with "Merged · PR #n" and the link (PRD acceptance 10).

### Segment Ledger

One row per theme, all themes. Columns: theme key and text; `Seen <n>×`; `Enforced by` (`judgment`, or the file path in mono); `Promoted` (date or text as recorded, or "—"); governance pill; ledger lines (`L12, L40`, mono). A structural theme shows one more line: "Enforcer results: not connected" until phase 3 (PRD: results come from the result chain of #2817 and #2818).

With field errors the Ledger segment lists the errors instead of the themes (`themes` is `[]`).

## Candidate drawer

`DrawerFrame` from the right, 720px wide at most. Opened from a candidate row; the URL gets `candidate/<candidate_id>`.

```text
┌ worktree-cleanup ─────────────────────────────── (● Judgment · not in root)  ✕ ┐
│ Delete only merged worktrees · Seen 7× · L12, L40, L77                          │
│                                                                                 │
│ Lesson                                                                          │
│   Mistake pattern   …                                                           │
│   Prevention rule   …                                                           │
│   Why               …                                                           │
│ Corrections         #2104 ↗  #2231 ↗  #2390 ↗                                    │
│ Enforcement ladder  1 Architecture or data shape  2 Type  3 Check that names    │
│                     the fix  4 Test  ·  judgment (current)                      │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ Action     [ Enforce ] [ Promote to root rules ]                                │
│ Task       (Task section, when this action has a task)                          │
│ Prompt     ┌───────────────────────────────────────────────────────────────┐    │
│            │ prefilled, editable                                           │    │
│            └───────────────────────────────────────────────────────────────┘    │
│            <!-- repo-harness.rules.candidate:… route:frontend -->  (locked)     │
│ Routing    ○ important_deep   worker-deep · claude · opus                       │
│ class      ● frontend         worker-important · claude · opus                  │
│            …  Estimate at this moment. The route picks the seat at dispatch.    │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ [ Submit ]  [ Copy prompt ]  [ Ask the advisor ]                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- Header: theme key (mono), governance pill, close. Line 2: name or theme text, `Seen`, ledger lines.
- Lesson: `Mistake pattern`, `Prevention rule`, `Why` as a definition list (fields that #2882 adds, F6).
- Corrections: each `correction_sources` entry as an `ExternalLink`.
- Enforcement ladder: the four levels of the Lessons Retro (architecture or data shape, type, a check whose error names the fix, test), then `judgment`. The current `Enforced by` value is marked "current".
- Action: a two-segment switch when the theme has both actions, `enforce` first and selected by default (owner decision 7). With one action, a plain label. The switch only changes the drawer content, so it uses `<button aria-pressed>`.
- Prompt: the textarea holds the prefilled prompt of the snapshot without its last line. The marker line shows below it in mono, read-only, and its `route:` part follows the selected class. Submit and Copy prompt use the edited text plus the marker line.
- Routing class: a radio list of the five classes of `routes`. Each row: class name (mono), expected seat id, runtime, model or "—". One note line: `rules.drawer.route.estimate`. No class is selected by default; Submit needs one.
- Footer:
  - Submit (primary, Kumo `Button`) shows only when `herdr` is `ready`, `ledger.valid` is `true`, `ledger.dirty` is `false`, and the selected action has no open task. Each condition reads one snapshot field; the server refusal stays the authority. A click locks the button until the answer arrives; a second click sends nothing.
  - Copy prompt (secondary) is always present (owner decision 4).
  - Ask the advisor (secondary) opens `OfficeAdvisorDialog` for the rules parent with `initialDraft` = theme key, action, `Seen`, governance and the prevention rule. It is disabled with the reason in its tooltip and below the footer when `orchestration.parent` is `null` or no advisor seat is known.

## Rules task view

The Task section of the candidate drawer. It shows when the selected action has `task` in the snapshot (#2888). It takes the place between Action and Prompt; when the task is open (`waiting_orchestration`, `in_progress`, `ready_for_go`, `unknown`), the Prompt and Routing sections and Submit are hidden. When the task is `merged`, `closed_unfinished`, `pr_rejected` or `failed`, the section shows the last task and the editor stays below it for a new filing.

```text
│ Task       (● Seat working · PR #2901)            governance: (● Judgment · not in root) │
│            Issue      #2950 ↗  rules: worktree-cleanup — enforce                          │
│            Route      frontend                                                            │
│            Seat       worker-important (active claim)                                     │
│            Pull request #2901 ↗                                                           │
│            GO         $ rh publication merge --repository … --pr 2901 --head … --base …  ⧉ │
│            [ Reconcile ]  (only after a refused or unconfirmed submit, see States)        │
```

- Two labels side by side, each with its own caption: Progress (dot + text) and Governance (pill). They never merge into one label.
- Issue: number, link, title. Route: the class from the marker. Seat: the seat of the active claim, or "No active claim". Pull request: number and link, or "No pull request yet".
- GO: shown only for `ready_for_go`, as a `CommandLine` with copy (CommandCopy). The text above it: `rules.task.go.note`. No request is sent when it shows. The command needs head and base SHAs that the snapshot does not carry yet (D1).
- Checks and acceptance show through `progress` only (`ready_for_go` means both pass at the head; `pr_rejected` covers a failed acceptance). There is no separate checks row (D2).
- With `orchestration.plan_comment` or `orchestration.coordinator_claim` `false`, a line under the progress label names each missing item (`rules.orchestration.missing.*`).

## All repositories (phase 4 sketch)

A fourth segment `#rules/all`, present only in phase 4. It reads every registered repository; the repository switch shows "All repositories" as on the other cross-repository pages.

```text
│ Theme key            repo-a              repo-b              repo-c           │
│ worktree-cleanup     (● Judgment · no)   (● Enforced by file) —               │
│ release-tag-order    (● Judgment · yes)  —                   (● Judgment · no)│
│ Source: a theme key copied from one template is marked "same template".       │
```

- Rows: theme keys that occur in two or more repositories, exact key match (PRD: first version matches only identical keys). Columns: repositories. A cell: the governance pill of that theme in that repository, or "—".
- A cell click opens that repository's Rules page at the candidate. Filing a built-in rule task is a phase 4 action and is not designed here.

## Two status groups

Governance and progress use different shapes: governance is a filled pill (StatusBadge pill, tint background), progress is a dot followed by text (StatusDot). They sit in different columns with their own captions. No color or word is shared between the groups.

| Governance (`themes[].governance`) | Tone | en | zh |
| --- | --- | --- | --- |
| ledger invalid (page state, no theme value) | `danger` | Ledger needs a fix | 账本需修复 |
| `judgment_unpromoted` | `warn` | Judgment · not in root rules | 靠 judgment · 未进根规则 |
| `judgment_promoted` | `neutral` | Judgment · in root rules | 靠 judgment · 已进根规则 |
| `structural` | `ok` | Enforced by a file | 已有结构性强制 |

| Progress (`task.progress`, eight values, F5) | Tone | en | zh |
| --- | --- | --- | --- |
| `waiting_orchestration` | `neutral` | Waiting for orchestration | 等待编排 |
| `in_progress` | `active` | Seat working · PR #{number} (without a PR: Seat working) | 席位在做 · PR #{number}（没有 PR 时：席位在做） |
| `ready_for_go` | `accent` | Waiting for your GO | 等你 GO |
| `merged` | `ok` | Merged · PR #{number} | 已合并 · PR #{number} |
| `closed_unfinished` | `neutral` | Closed · not finished | 已关闭 · 未完成 |
| `pr_rejected` | `warn` | PR rejected | PR 被拒 |
| `failed` | `danger` | Failed | 失败 |
| `unknown` | `unknown` (hollow) | Status unknown | 状态未知 |

`task: null` is not a progress value. The page shows "Not filed" / "未发起" with no dot. The PRD word 等你发起 counts these actions on Home, which is out of scope here (#2890).

`accent` marks only `ready_for_go`, the one state that waits on the owner (console brief color rule).

## States

Each state gives its layout and its text. The text keys are in [Copy](#copy).

| State | Trigger (snapshot or answer) | Layout | Text keys |
| --- | --- | --- | --- |
| Ledger invalid | `ledger.valid: false` with field errors (`themes` is `[]`) | Error SourceBanner; the Candidates segment shows no row; the Ledger segment lists each field error: line, theme, field, value, fix | `rules.ledger.invalid.*`, `rules.ledger.error.*` |
| Evidence errors only | `ledger.valid: false`, no field error, `themes` present (F9) | Warning SourceBanner with the error list collapsed under "Show {count} errors" (each row: theme and its `Triggered by correction` value); candidates stay; Submit hidden (#2887 refuses `ledger_invalid`) | `rules.ledger.evidence.*` |
| Ledger dirty | `ledger.dirty: true` | Warning SourceBanner; Submit hidden (#2887 refuses `ledger_changed`) | `rules.ledger.dirty.*` |
| No candidate | ledger valid, no theme has an action | `BoardState` with one sentence and a link to the Ledger segment | `rules.empty.*` |
| Herdr unavailable | `herdr: "unavailable"` | Drawer: Copy prompt only, no Submit; one info line above the footer | `rules.herdr.unavailable.*` |
| Waiting for orchestration | `progress: waiting_orchestration`; `orchestration` flags | Task section: progress label and one line per missing item | `rules.orchestration.*` |
| Submit failed | `postOperatorWrite` → `refused` | Error `Banner` in the drawer footer: the code text, whether an issue exists (`error.issue`), the server `next_action`; Reconcile control; no timer | `rules.submit.refused.*`, `rules.reconcile.*` |
| Submit result uncertain | `unreachable`, `unreadable`, or 409 `reconcile_required` | Warning `Banner`: the request may have run; Reconcile control; Submit stays locked for this request | `rules.submit.uncertain.*`, `rules.reconcile.*` |
| Write token invalid | `reload_required` | `WriteReloadBanner` (existing) | `write.reload.*` (existing) |
| Page unavailable | the six reasons of #2885 and `unreachable` | Refusal card as on the Tests page: dot (`warn` for `rules_pending`, `registry_unavailable`, `repository_not_found`; `danger` for the rest) and the reason text | `rules.reason.*` |

Refusal details:

- `candidate_open`: show the existing issue link; the drawer then shows that issue in the Task section after the next collection. No second Submit.
- `ledger_changed`, `candidate_not_found`, `ledger_invalid`: the text asks the owner to reload the page data and review the candidate again. No Reconcile.
- `rules_parent_ambiguous`: the text names the condition (more than one open rules parent) and the fix (close the extra parent). No Reconcile.
- `herdr_unavailable`: same text as the Herdr unavailable state.
- `prompt_marker_missing`: should not occur, because the marker line is locked. Show the code text.
- `request_mismatch`: a reused `request_id` with another body. Show the code text; the next Submit click makes a new `request_id`.
- Any other code: the raw code, the server `message` and `next_action`.

Reconcile sends `rules_reconcile` once per click. Its answer shows the issue link and the three steps (`issue`, `label`, `sub_issue`) with their values (`created`/`found`, `added`/`present`, `linked`/`present`). `candidate_not_filed` means no issue exists; then Submit shows again with a new `request_id`.

After a filed answer the drawer shows the issue link and "Filed as #{issue}. Progress shows after the next collection." The progress label comes only from the snapshot.

## Copy

`en` is the source; `zh` uses the words of the PRD section 状态用语. `{name}` is a parameter. Status words are in [Two status groups](#two-status-groups).

### Page, segments, ledger

| Key | en | zh |
| --- | --- | --- |
| `nav.rules` | Rules | 规则 |
| `rules.boundary` | Promotion candidates from the lessons ledger. The console files a task; it never dispatches, merges or edits the ledger. | 账本里的晋升候选。控制台只建任务，不派工、不合并、不改账本。 |
| `rules.loading` | Reading the rules status | 正在读取规则状态 |
| `rules.source` | {path} · head {head} · collected {age} | {path} · head {head} · 采集于 {age} |
| `rules.segment.candidates` | Candidates | 候选 |
| `rules.segment.ledger` | Ledger | 账本 |
| `rules.column.theme` | Theme | 主题 |
| `rules.column.seen` | Seen | Seen |
| `rules.column.governance` | Governance | 治理结果 |
| `rules.column.actions` | Actions | 动作 |
| `rules.column.progress` | Progress | 任务进度 |
| `rules.column.enforcedBy` | Enforced by | Enforced by |
| `rules.column.promoted` | Promoted | Promoted |
| `rules.column.lines` | Lines | 行 |
| `rules.seen` | Seen {count}× | Seen {count}× |
| `rules.action.enforce` | Enforce | 机器强制 |
| `rules.action.promote_root` | Promote to root rules | 补根规则 |
| `rules.task.notFiled` | Not filed | 未发起 |
| `rules.ledger.enforcer.notConnected` | Enforcer results: not connected | 强制手段运行情况：未接入 |
| `rules.empty.title` | No promotion candidate | 没有晋升候选 |
| `rules.empty.body` | No theme of the ledger has an open action. | 账本里没有主题需要晋升。 |
| `rules.empty.link` | Open the ledger | 查看账本 |

### Ledger states

| Key | en | zh |
| --- | --- | --- |
| `rules.ledger.invalid.title` | The ledger failed validation | 账本格式检查没过 |
| `rules.ledger.invalid.body` | `tasks/lessons.md` has {count} errors. The page shows no candidate until they are fixed. Fix the lines below and commit. | `tasks/lessons.md` 有 {count} 处错误。修好之前不显示候选。按下面的行修改并提交。 |
| `rules.ledger.error.line` | Line {line} | 第 {line} 行 |
| `rules.ledger.error.fix` | Fix: {fix} | 修法：{fix} |
| `rules.ledger.error.trigger` | Triggered by correction: {trigger} | Triggered by correction：{trigger} |
| `rules.ledger.evidence.title` | The ledger has evidence errors | 账本有证据错误 |
| `rules.ledger.evidence.body` | {count} entries name only a consolidation commit in `Triggered by correction`. Candidates show, but filing a task waits until the entries name the real correction. | {count} 条记录的 `Triggered by correction` 只写了合并整理的提交。候选照常显示，改成真正的纠正来源之前不能建任务。 |
| `rules.ledger.evidence.show` | Show {count} errors | 显示 {count} 处错误 |
| `rules.ledger.dirty.title` | The ledger has uncommitted changes | 账本有未提交的改动 |
| `rules.ledger.dirty.body` | The page shows the committed version of `tasks/lessons.md`. Commit or discard the change before you file a task. | 页面显示的是已提交的 `tasks/lessons.md`。先提交或丢弃改动，再建任务。 |

### Page unavailable (reasons of #2885)

| Key | en | zh |
| --- | --- | --- |
| `rules.reason.rules_pending` | The rules status is not collected yet | 规则状态还没采集 |
| `rules.reason.registry_unavailable` | The repository registry is unreadable | 仓库登记表读不到 |
| `rules.reason.repository_not_found` | The repository is not registered | 仓库没有登记 |
| `rules.reason.rules_command_failed` | `rh rules status` failed in this repository | 在这个仓库运行 `rh rules status` 失败 |
| `rules.reason.rules_invalid` | The rules status failed validation | 规则状态没通过校验 |
| `rules.reason.unreachable` | The rules route gave no usable answer | 规则路由没有给出可用的结果 |

### Drawer

| Key | en | zh |
| --- | --- | --- |
| `rules.drawer.lesson` | Lesson | Lesson |
| `rules.drawer.mistakePattern` | Mistake pattern | Mistake pattern |
| `rules.drawer.preventionRule` | Prevention rule | Prevention rule |
| `rules.drawer.why` | Why | Why |
| `rules.drawer.corrections` | Corrections | 纠正来源 |
| `rules.drawer.ladder` | Enforcement ladder | 强制阶梯 |
| `rules.drawer.ladder.architecture` | Architecture or data shape | 架构或数据结构 |
| `rules.drawer.ladder.type` | Type | 类型 |
| `rules.drawer.ladder.check` | Check whose error names the fix | 报错写明修法的检查 |
| `rules.drawer.ladder.test` | Test | 测试 |
| `rules.drawer.ladder.judgment` | judgment, only when no level above works | judgment，四级都不行时才用 |
| `rules.drawer.ladder.current` | current | 当前 |
| `rules.drawer.action` | Action | 动作 |
| `rules.drawer.prompt` | Prompt | Prompt |
| `rules.drawer.prompt.marker` | This line finds the task again. It cannot be edited. | 这一行用来找回任务，不能修改。 |
| `rules.drawer.route` | Routing class | 任务类别 |
| `rules.drawer.route.estimate` | Expected seat at this moment. The route picks the seat at dispatch, so it can change with the quota. | 按当前配额预计的席位。派工时由路由决定，配额变了结果会不同。 |
| `rules.drawer.route.required` | Select a routing class | 请选择任务类别 |
| `rules.drawer.submit` | Submit | 提交 |
| `rules.drawer.submitting` | Submitting | 正在提交 |
| `rules.drawer.copyPrompt` | Copy prompt | 复制 prompt |
| `rules.drawer.askAdvisor` | Ask the advisor | 问顾问席 |
| `rules.drawer.askAdvisor.noParent` | No rules parent exists yet. The first submit creates it. | 还没有规则父 issue，第一次提交时会建。 |
| `rules.drawer.askAdvisor.noSeat` | No advisor seat is running. | 没有运行中的顾问席。 |
| `rules.drawer.lastTask` | Last task: #{issue}, {progress}. The ledger still lists this action. | 上一个任务：#{issue}，{progress}。账本里这个动作仍然是候选。 |
| `rules.herdr.unavailable.body` | Herdr is not available on this machine, so the console cannot file the task. Copy the prompt and run it in your own harness. | 这台机器没有 Herdr，控制台不能建任务。复制 prompt，拿到自己的 harness 里执行。 |

### Task view and orchestration

| Key | en | zh |
| --- | --- | --- |
| `rules.task.heading` | Task | 任务 |
| `rules.task.issue` | Issue | Issue |
| `rules.task.route` | Route | 任务类别 |
| `rules.task.seat` | Seat | 席位 |
| `rules.task.seat.none` | No active claim | 没有认领 |
| `rules.task.pr` | Pull request | PR |
| `rules.task.pr.none` | No pull request yet | 还没有 PR |
| `rules.task.go` | GO | GO |
| `rules.task.go.note` | Checks and acceptance pass at the head. Run this command in a terminal to give GO; the console does not run it. | 检查和验收在当前 head 上都通过。在终端运行这条命令给 GO，控制台不运行它。 |
| `rules.task.filed` | Filed as #{issue}. Progress shows after the next collection. | 已建 #{issue}。下一次采集后显示进度。 |
| `rules.orchestration.waiting` | The coordinator dispatches this task. The console never dispatches. | 由编排席派工，控制台不派工。 |
| `rules.orchestration.missing.parent` | No rules parent issue | 没有规则父 issue |
| `rules.orchestration.missing.planComment` | No plan comment on #{parent} | #{parent} 上没有计划评论 |
| `rules.orchestration.missing.coordinatorClaim` | No active coordinator claim on #{parent} | #{parent} 上没有编排席的认领 |

### Submit and reconcile

| Key | en | zh |
| --- | --- | --- |
| `rules.submit.refused.title` | The task was not filed | 任务没有建成 |
| `rules.submit.refused.issueExists` | Issue #{issue} exists for this candidate. | 这个候选已有 issue #{issue}。 |
| `rules.submit.refused.noIssue` | No issue was created. | 没有建 issue。 |
| `rules.submit.refused.code.candidate_open` | This candidate already has an open task. | 这个候选已有未关闭的任务。 |
| `rules.submit.refused.code.ledger_changed` | The ledger changed after this page read it. Reload the page data and review the candidate again. | 页面读取之后账本变了。刷新数据，重看候选后再提交。 |
| `rules.submit.refused.code.ledger_invalid` | The ledger failed validation. Fix it before you file a task. | 账本格式检查没过。修好再建任务。 |
| `rules.submit.refused.code.candidate_not_found` | The ledger no longer lists this candidate. Reload the page data. | 账本里已经没有这个候选。刷新数据。 |
| `rules.submit.refused.code.rules_parent_ambiguous` | More than one open rules parent issue exists. Close the extra one, then submit again. | 有不止一个未关闭的规则父 issue。关掉多余的再提交。 |
| `rules.submit.refused.code.prompt_marker_missing` | The prompt lost its last marker line. | prompt 缺少最后的标记行。 |
| `rules.submit.refused.code.herdr_unavailable` | Herdr is not available on this machine. Copy the prompt instead. | 这台机器没有 Herdr。改为复制 prompt。 |
| `rules.submit.refused.code.request_mismatch` | This request id was used with another body. Submit again to send a new request. | 这个请求号已用于另一份内容。再点一次提交会发新的请求。 |
| `rules.submit.uncertain.title` | The submit is not confirmed | 提交结果待核对 |
| `rules.submit.uncertain.body` | The console got no confirmed answer, so the issue may exist. Reconcile checks GitHub and completes the missing steps. Do not submit again first. | 控制台没有收到确认，issue 可能已经建了。「核对」会查 GitHub 并补齐缺的步骤。不要先重新提交。 |
| `rules.reconcile` | Reconcile | 核对 |
| `rules.reconcile.running` | Reconciling | 正在核对 |
| `rules.reconcile.done` | Issue #{issue}: issue {issueStep}, label {labelStep}, sub-issue {subIssueStep} | Issue #{issue}：issue {issueStep}，标签 {labelStep}，子 issue {subIssueStep} |
| `rules.reconcile.step.created` | created | 已建 |
| `rules.reconcile.step.found` | found | 已存在 |
| `rules.reconcile.step.added` | added | 已加 |
| `rules.reconcile.step.linked` | linked | 已关联 |
| `rules.reconcile.step.present` | present | 已存在 |
| `rules.reconcile.notFiled` | No issue exists for this candidate. You can submit again. | 这个候选没有 issue，可以重新提交。 |
| `rules.refused.unknown` | {code}: {message} | {code}：{message} |

### BDD Acceptance Scenarios

- `UX-rules-review-P1` (phase 1, #2886): Given a snapshot with 16 themes and 10 themes with actions, When the owner opens `#rules`, Then the Candidates segment shows 10 rows, each with key, `Seen`, the governance pill and the action lines with "Not filed"; the Ledger segment shows 16 rows; the side rail shows Rules in the group Observe after Tests.
- `UX-rules-review-P2` (phase 2, #2890): Given Herdr ready, a valid clean ledger and a candidate with no task, When the owner edits the prompt, selects `frontend` and clicks Submit twice, Then one `POST` goes to `rules_promote` with the edited prompt plus the marker line, `route: "frontend"`, the snapshot `ledger.blob` and a new `request_id`; the second click sends nothing; the drawer shows "Filed as #n".
- `UX-rules-review-P3` (phase 2): Given a task with `progress: ready_for_go`, When the owner opens the drawer, Then the Task section shows "Waiting for your GO" and the governance pill as two labels, and the GO command as copyable text; no request is sent.
- `UX-rules-review-P4` (phase 2): Given a task with `progress: merged` and the theme still has the action, When the page renders, Then the row stays a candidate with "Merged · PR #n" and the governance pill is unchanged (PRD acceptance 10).
- `UX-rules-review-N1`: Given any snapshot and any task state, When the page and the drawer render, Then no control dispatches, merges, gives GO, picks a seat or edits the ledger; the only `POST` routes are `rules_promote` and `rules_reconcile`; no `candidate_id` hex outside the marker line, no `request_id`, prompt file path, absolute path, stderr or token is rendered.
- `UX-rules-review-N2`: Given `herdr: "unavailable"`, When the owner opens the drawer, Then there is no Submit, Copy prompt is present, and the Herdr text shows (PRD acceptance 9).
- `UX-rules-review-F1`: Given `ledger.valid: false` with field errors, When the owner opens `#rules`, Then the error banner shows the count, the Ledger segment lists each field error with line, field, value and fix, and the Candidates segment shows no row (PRD acceptance 2).
- `UX-rules-review-F2`: Given evidence errors only (F9), When the page renders, Then the warning banner shows, the candidates stay, and the drawer has no Submit.
- `UX-rules-review-F3`: Given `postOperatorWrite` returns `unreachable` or 409 `reconcile_required`, When the answer arrives, Then the drawer shows "The submit is not confirmed" and Reconcile, starts no timer, and does not re-enable Submit for that request.
- `UX-rules-review-F4`: Given a 409 `candidate_open` with `issue: 2950`, When the answer arrives, Then the drawer shows the link to #2950 and no Submit.
- `UX-rules-review-F5`: Given `progress: unknown`, When the page renders, Then the action line shows the hollow dot and "Status unknown", never an earlier value.
- `UX-rules-review-F6`: Given each unavailable reason of #2885 and `unreachable`, When the page renders, Then each shows its own text and no list or count.

#2886 carries P1, N1 (phase 1 part), F1, F2 (page part), F5 and F6. #2890 carries P2-P4, N1, N2, F2 (drawer part), F3 and F4.

## Document issues

| # | Where | Issue | Proposed resolution |
| --- | --- | --- | --- |
| D1 | #2888 `task.pull_request`, #2890 "GO command as text" | `rh publication merge` needs `--head <sha>` and `--base <sha>` (`assets/skills/repo-harness-issue-flow/references/orchestrator.md:542`). `task.pull_request` has only `number` and `url`. The board already has `head_sha` and `base_sha` (`src/core/board/board.ts:130-136`) | #2888 adds `head_sha` and `base_sha` to `task.pull_request`. Until then #2890 cannot show a complete GO command; it must not show a partial one |
| D2 | #2890 "checks and acceptance" | `task` has no separate check or acceptance field; `progress` encodes them (`ready_for_go`, `pr_rejected`) | The task view shows them through `progress` only. A separate row needs fields in #2888 first |
| D3 | PRD 模块与读模型: "one theme, two actions, only one in progress at a time" | No child enforces it: #2887 deduplicates by candidate marker, and a candidate is one theme and one action | The drawer hides Submit only for the selected action with an open task; the other action stays fileable. A theme-level block needs a refusal in #2887 and #2889, decided by the coordinator |
| D4 | #2886 "`ledger.valid: false` → no candidate" vs F9 | F9 keeps the candidates on an evidence-only error | This brief follows F9 (state "Evidence errors only") |
| D5 | PRD 状态用语 lists 等你发起 as a progress word | #2888 has eight values (F5); an action with no task has `task: null` | Shown as "Not filed" with no dot; it is not a progress value |
| D6 | PRD 页面 table: Rules page "three segments" | Enabled rules is phase 3 | Two segments in phases 1 and 2; no placeholder |
| D7 | #2886 "each field error and evidence error with its line and its fix text" | A triage evidence row has `theme` and `trigger` only (`scripts/maintenance-triage.sh:147-156`); only field rows have `line` and `fix` (`:139-144`) | Field rows show line and fix; evidence rows show theme and trigger. A line for evidence rows needs #2881 or #2882 to add it |

## Reference Sources

| Source | Learn | Avoid |
| --- | --- | --- |
| [`DESIGN-operator-console-uiux.md`](DESIGN-operator-console-uiux.md) | Shell, status color rules, CommandCopy for anything the console does not run | — |
| Tests page (`src/operator-web/TestsPage.tsx`) | Read-only page over a collector route; one refusal card per reason | — |
| Task drawer (`src/operator-web/TaskDrawer.tsx`) | Drawer sections, identifier rows, copyable commands | Its stage stepper: rules progress has eight values, not a linear pipeline |
| Office advisor dialog (`src/operator-web/OfficeAdvisorDialog.tsx`) | Locked send during a request; the `reconcile_required` notice | — |
| GitHub sub-issues list | One row per child issue with its state | Treating a merged PR as done: governance comes from the ledger |

Primary reference: the console brief and the Tests page. No outside visual source.

## Color

- Palette: inherited from the console brief: Paper and Ink neutrals, carrot as the one brand color, tokens in [`tokens.json`](../design/operator-console/design-system/tokens.json).
- Usage rules: Submit uses `color-kumo-brand`. `rh-accent` marks only `ready_for_go`. Governance and progress tones are in [Two status groups](#two-status-groups). Ledger invalid uses `color-kumo-danger`; evidence errors and dirty use `color-kumo-warning`. Unknown is the hollow dot. Text contrast stays at 4.5:1 or more in both themes.

## Typography

- Typeface(s): inherited: Space Grotesk for titles and buttons, IBM Plex Sans for text, JetBrains Mono for theme keys, `Seen`, line numbers, file paths, routing classes, seat ids, the marker line and commands.
- Scale / weights: inherited. Page title 18px/600; row text 14px; secondary line and captions 12-13px; prompt editor 13px body text.
- Language-specific notes: `zh` falls back to PingFang SC, Hiragino Sans GB, Microsoft YaHei. Ledger field names (`Mistake pattern`, `Enforced by`, `Promoted`, `Seen`) stay in English in both locales because they are ledger syntax.

## Layout

- Grid / breakpoints: inherited: main area 1152px at most; drawer 720px at most; below 760px the side rail becomes a drawer. The candidate table becomes stacked rows below 760px (theme, then governance, then actions).
- Spacing scale: inherited 4, 8, 12, 16, 24, 32px.
- Key components and hierarchy: header (title, boundary, source line) → SegmentedTabs → one SourceBanner slot → ListGroup table. Drawer: header → lesson block → Action → Task (when present) → Prompt → Routing class → footer.

## Motion

- Trigger -> effect pairs: drawer open uses the existing slide-in (160ms) and scrim fade (120ms) of `DrawerFrame`; copy shows "Copied" in place for about 2 seconds; Submit and Reconcile show a `Loader` while in flight.
- Duration / easing: inherited 120 / 180 / 280ms, `cubic-bezier(0.22, 0.61, 0.36, 1)`.
- What must stay static: status dots, pills, counts and rows; no progress animation; near zero under `prefers-reduced-motion`.

## Anti-patterns

- A GO, merge or dispatch control that looks like it runs. The GO is a CommandCopy only.
- A seat picker, or a seat name shown as the chosen value instead of an estimate.
- One combined status label that mixes governance and progress.
- A merged PR shown as "promoted" or "enforced".
- An empty candidate list or `0` in place of an invalid ledger or a failed read.
- A retry timer, or a re-enabled Submit after an unconfirmed answer.
- An editable marker line.
- A placeholder segment for Enabled rules or All repositories before their phase.
- A solid grey dot for `unknown`.

## Confirmation Checklist

- [ ] Value proposition is clear
- [ ] Primary reference is decided
- [ ] Color is accurate to the reference
- [ ] Anti-pattern / don't list is explicit
- [ ] Motion spec is explicit
- [ ] Product rules/non-goals are frozen; instruction and payload are separate
- [ ] Existing component/domain authorities have exact reuse paths; every new surface is justified
- [ ] Positive, negative, and authority-failure Given/When/Then scenarios are explicit and fail loudly
- [ ] Role-aware visible/backstage-only concept boundary is explicit; `UX-rules-review-N1` matches a backstage-only or non-goal concept

The approving joint decision on #2884 checks these items.

## Preview Attachment

- Preview path/link: none. The text wireframes above are the layout reference.
