# repo-harness 0.33.2 publication record

## Release scope

- Release date: UTC 2026-11-17. Parent [#2742](https://github.com/aimpact-inc/repo-harness/issues/2742); no separate release issue.
- Owner word, relayed locally by the advisor seat and recorded in [#2742 comment 6924525557](https://github.com/aimpact-inc/repo-harness/issues/2742#issuecomment-6924525557) at 2026-11-16T17:55:00Z: "那你等一起，发0.33.2吧，我不想再发一个，下一版就直接跳0.34了". The recorded reading: one release, version 0.33.2; the next release is 0.34.0.
- Owner word for this release without #2926, in [#2960 comment 6935889250](https://github.com/aimpact-inc/repo-harness/pull/2960#issuecomment-6935889250) at 2026-11-17T02:16:21Z: "先發，不含 #2926 (Recommended)".
- Owner word on the version after six breaking fragments reached main, in [#2960 comment 6935965164](https://github.com/aimpact-inc/repo-harness/pull/2960#issuecomment-6935965164) at 2026-11-17T02:20:19Z: "維持 0.33.2". The release ships every commit up to the source commit, with the breaking fragments, under 0.33.2.
- #2936 merged as `e95dee83b` (#2949). PR #2926 (#2916) is open and stays out of this release by the owner word.
- #2898, #2922, #2894 and #2893 stay out of this release; they merge after the `v0.33.2` tag.
- Source commit before release prep: `e7bb9b1a1786baf17fcf0f412d48fef3a872cf65`. The release range is `v0.33.1..e7bb9b1a1`, 85 commits, 36 changelog fragments. `e7bb9b1a1` is the last base: main merges are frozen until this PR merges, and #2998 is the one exception.
- Breaking changes ship in this patch version by the owner word "維持 0.33.2": #2863 removes `rh init-hook` and three `rh update` options; #2867 replaces `--write` with `--apply`; #2864, #2865, #2866 and #2871 move commands under `rh worktrees`, `rh verify`, `rh capability` and `rh arch`; #2937 deletes `rh brain` and `rh migrate`; #2941 renames the `AGENTIC_DEV_*` variables to `REPO_HARNESS_*`. No alias stays. The `### Breaking` section opens with one `Migration:` line per old name, from the retired-helper map in `src/cli/commands/run.ts`, the v0.33.1 command definitions and `rh commands` at the source commit.
- Release prep correction: the #2798 Fixed entry named `rh update --check`, which #2863 removes in the same release. The entry now names `rh setup check` only. The #2795 entry said to run `rh brain check` and `rh brain sync`; #2937 deletes `rh brain` in this release, so the entry now says that.
- Release prep added one changelog entry, from the merged PR, for each of 14 changes that had no fragment: #2862, #2868, #2870, #2881 (PR #2928), #2823, #2824, #2825, #2826 (Added); #2913, #2923, #2814 (Changed); #2843, #2844, #2917 (Fixed). The orchestrator asked for these entries. #2956 (Changed) and #2955 (Fixed) merged after the first prep commit without a fragment; release prep added their entries the same way.
- After `ab65af6e2`, ten user-visible changes merged without a fragment. Release prep added one entry each, from the merged PR: #2885, #2887, #2888 (Added); #2963, #2964, #2969, #2970, #2974, #2977, #2988 (Fixed). The other commits without an entry change only tests, CI, the architecture model, the projection or the release smoke: #2976, #2983, #2986, #2990, #2993, #2994, #2998.

| PR | Commit | Change |
|---|---|---|
| [#2797](https://github.com/aimpact-inc/repo-harness/pull/2797) | `8fbc6714c` | fix(release): rebuild managed values for v0.33.1 (#2793) |
| [#2801](https://github.com/aimpact-inc/repo-harness/pull/2801) | `90b6b4ee2` | fix(doctor): mark CodeGraph index not applicable outside repositories (#2784) |
| [#2803](https://github.com/aimpact-inc/repo-harness/pull/2803) | `6b407ecda` | fix(adoption): retire the check:brain and sync:brain package scripts (#2795) |
| [#2802](https://github.com/aimpact-inc/repo-harness/pull/2802) | `1e0901c8a` | fix(review): name the retired protocol and the invalid keys in receipt errors (#2800) |
| [#2804](https://github.com/aimpact-inc/repo-harness/pull/2804) | `2f5f16698` | fix(doctor): treat the hoisted archctx at the pin as managed (#2783) |
| [#2805](https://github.com/aimpact-inc/repo-harness/pull/2805) | `cc7cf86f8` | feat(seats): an owner exception for the quota reservation and an unavailable provider list (#2769) |
| [#2828](https://github.com/aimpact-inc/repo-harness/pull/2828) | `25957bf14` | fix(cli): a remediation argv that rh accepts (#2798) |
| [#2830](https://github.com/aimpact-inc/repo-harness/pull/2830) | `bd139f5a4` | docs(lessons-retro): define cumulative Seen and Missed by: unknown (#2812) |
| [#2831](https://github.com/aimpact-inc/repo-harness/pull/2831) | `a07ceed91` | docs(adr): decide the test budget result contract (#2816) |
| [#2834](https://github.com/aimpact-inc/repo-harness/pull/2834) | `67e13cc86` | fix(cli-name): stop reporting a repository slug as a retired command call (#2799) |
| [#2835](https://github.com/aimpact-inc/repo-harness/pull/2835) | `8b370f12f` | docs(researches): measure Eraser Diagrams rendering for G39 (#2822) |
| [#2832](https://github.com/aimpact-inc/repo-harness/pull/2832) | `155b7a6c9` | docs(prds): add gap G39 to the operator console PRD (#2821) |
| [#2837](https://github.com/aimpact-inc/repo-harness/pull/2837) | `85bdeb953` | docs(prds): land the ledger enforcement and test-budget PRD (#2811) |
| [#2833](https://github.com/aimpact-inc/repo-harness/pull/2833) | `f4a907ffd` | docs(lessons): migrate the 16 entries to the Lessons Retro fields (#2813) |
| [#2836](https://github.com/aimpact-inc/repo-harness/pull/2836) | `88dd5c4f6` | fix(review): no sandboxed review process holds a native credential (#2764) |
| [#2840](https://github.com/aimpact-inc/repo-harness/pull/2840) | `699a8f783` | feat(operator): validate a diagram JSON block before any render (#2823) |
| [#2857](https://github.com/aimpact-inc/repo-harness/pull/2857) | `98a4ff9ea` | feat(maintenance-triage): list judgment themes from cumulative Seen (#2814) |
| [#2858](https://github.com/aimpact-inc/repo-harness/pull/2858) | `df01a1b4a` | docs(architecture): the acceptance-review sandbox row drops the copied auth.json (#2808) |
| [#2829](https://github.com/aimpact-inc/repo-harness/pull/2829) | `8a50c2ce8` | feat(upgrade): open one refresh PR per registered repo with --pr (#2320) |
| [#2839](https://github.com/aimpact-inc/repo-harness/pull/2839) | `462f0935d` | feat(seats): add the read-only gatekeeper-deep review seat (#2796) |
| [#2877](https://github.com/aimpact-inc/repo-harness/pull/2877) | `320ead851` | fix(fleet): save user agents before forced replacement (#2843) |
| [#2856](https://github.com/aimpact-inc/repo-harness/pull/2856) | `37bb9d559` | feat(test-budget): TestBudget rule, exception parser and rules policy section (#2817) |
| [#2876](https://github.com/aimpact-inc/repo-harness/pull/2876) | `cc4f0724f` | fix(uninstall): keep an edited rules block and report Codex hook trust as a note (#2842) |
| [#2891](https://github.com/aimpact-inc/repo-harness/pull/2891) | `b1e48b16e` | feat(test-budget): job summary of the TestBudget result (#2820) |
| [#2875](https://github.com/aimpact-inc/repo-harness/pull/2875) | `f68a70275` | docs(architecture): declare the host-config component and its write boundary (#2845) |
| [#2892](https://github.com/aimpact-inc/repo-harness/pull/2892) | `c4906daef` | chore(projection): refresh generated architecture outputs for main@f68a70275440 |
| [#2859](https://github.com/aimpact-inc/repo-harness/pull/2859) | `fc3d46cdc` | feat(operator): render a docs diagram when it changes and show it as an image (#2824) |
| [#2902](https://github.com/aimpact-inc/repo-harness/pull/2902) | `c6f8c7499` | test(oar-host): replace wall-clock upper bounds in the deadline-stop test with order assertions |
| [#2901](https://github.com/aimpact-inc/repo-harness/pull/2901) | `1e26f3aed` | feat(operator): export a shown diagram as the stored SVG on request (#2825) |
| [#2895](https://github.com/aimpact-inc/repo-harness/pull/2895) | `43ab7df07` | feat(operator): one command returns the PNG of a diagram for agent readback (#2826) |
| [#2907](https://github.com/aimpact-inc/repo-harness/pull/2907) | `2b758d771` | test: fixture bun is an exec wrapper, not a symlink to the real binary |
| [#2855](https://github.com/aimpact-inc/repo-harness/pull/2855) | `6501c27e8` | feat(review): packet names round, harness and hand-off; collect binds Pi and Claude sessions by packet (#2838) |
| [#2920](https://github.com/aimpact-inc/repo-harness/pull/2920) | `0b70a54b7` | feat(arch): rh arch runs any command of the pinned archctx (#2870) |
| [#2924](https://github.com/aimpact-inc/repo-harness/pull/2924) | `c4c5ca24d` | docs(prds): design brief for the Rules workspace of the operator console (#2884) |
| [#2918](https://github.com/aimpact-inc/repo-harness/pull/2918) | `d57c4d20b` | feat(seats): Pi review seats load the rh hook extension (#2913) |
| [#2925](https://github.com/aimpact-inc/repo-harness/pull/2925) | `5dedf0e3d` | feat(board): the dispatch packet carries the worker Authority line (#2923) |
| [#2914](https://github.com/aimpact-inc/repo-harness/pull/2914) | `d7ee6eccb` | feat(quota): the exhausted line is a seats.routing setting (default 95) (#2909) |
| [#2912](https://github.com/aimpact-inc/repo-harness/pull/2912) | `a691cf44c` | fix(installer): own the marked Herdr skill copies under core (#2844, P-a) |
| [#2929](https://github.com/aimpact-inc/repo-harness/pull/2929) | `f509d7542` | docs(adr): ADR-0005 no task inbox write from the operator console (#2883) |
| [#2928](https://github.com/aimpact-inc/repo-harness/pull/2928) | `ec820d488` | feat(maintenance-triage): report every ledger theme in --json |
| [#2927](https://github.com/aimpact-inc/repo-harness/pull/2927) | `5892b31f2` | docs(rules): security bar is I1/I2; owner list, review tiers and comment rules follow (#2915) |
| [#2921](https://github.com/aimpact-inc/repo-harness/pull/2921) | `cd4a6d621` | feat(board): review and attention take the configured reviewer seat, not Claude |
| [#2932](https://github.com/aimpact-inc/repo-harness/pull/2932) | `517c3be4a` | feat(bots): rh bots list and rh bots show read the Bot registry (#2868) |
| [#2931](https://github.com/aimpact-inc/repo-harness/pull/2931) | `c56e98332` | fix(seats): the settings save runs the read-path decoder before it writes (#2917) |
| [#2919](https://github.com/aimpact-inc/repo-harness/pull/2919) | `3c24efacd` | feat(cli): rh commands manifest and check:cli-manifest drift check (#2862) |
| [#2939](https://github.com/aimpact-inc/repo-harness/pull/2939) | `3e7360f6e` | feat(board): rh board post writes the protocol comments that the board parses |
| [#2935](https://github.com/aimpact-inc/repo-harness/pull/2935) | `75ffcfb59` | ci: macOS jobs of Required / CI run on macos-15-intel (#2934) |
| [#2943](https://github.com/aimpact-inc/repo-harness/pull/2943) | `680622548` | docs(skills): the worker SOP runs the ArchContext loop (#2872) |
| [#2944](https://github.com/aimpact-inc/repo-harness/pull/2944) | `b8a693de4` | docs: remove the retired-feature residue from reference configs and module docs (#2940) |
| [#2945](https://github.com/aimpact-inc/repo-harness/pull/2945) | `db98e500d` | fix(cli): rh commands and check:cli-manifest agree on implicit help leaves (#2942) |
| [#2946](https://github.com/aimpact-inc/repo-harness/pull/2946) | `509b08b9a` | feat(rules): rh rules status reads the ledger themes and names the promotion candidates |
| [#2951](https://github.com/aimpact-inc/repo-harness/pull/2951) | `25a33937f` | feat(cli)!: rh setup check is the one name of the setup checklist (#2863) |
| [#2950](https://github.com/aimpact-inc/repo-harness/pull/2950) | `46f82ef04` | fix(cli): check:cli-manifest resolves the target of an implicit help path (#2948) |
| [#2949](https://github.com/aimpact-inc/repo-harness/pull/2949) | `e95dee83b` | feat(review): P2 findings do not block a merge; FAIL needs a P0 or P1 |
| [#2933](https://github.com/aimpact-inc/repo-harness/pull/2933) | `ac5932523` | feat(arch): rh arch verify gives one verdict over the ArchContext checks (#2873) |
| [#2952](https://github.com/aimpact-inc/repo-harness/pull/2952) | `a88a201e5` | feat(board): High review runs as a relay, the reviewer starts after the gatekeeper PASS (#2910) |
| [#2957](https://github.com/aimpact-inc/repo-harness/pull/2957) | `3dd1f3d34` | fix(rules): resolve repository root and refuse missing ledger (#2954) |
| [#2959](https://github.com/aimpact-inc/repo-harness/pull/2959) | `8e6cb4e3f` | fix(seats): accept zai GLM-5.3 for Pi seats (#2956) |
| [#2958](https://github.com/aimpact-inc/repo-harness/pull/2958) | `ab65af6e2` | fix(review): require an unresolved P0 or P1 for FAIL (#2955) |
| [#2962](https://github.com/aimpact-inc/repo-harness/pull/2962) | `692b61f4d` | feat(operator): serve cached repository rules status (#2885) |
| [#2953](https://github.com/aimpact-inc/repo-harness/pull/2953) | `3cbadcb99` | refactor(cli): delete the rh brain surface and rh migrate (#2937) |
| [#2961](https://github.com/aimpact-inc/repo-harness/pull/2961) | `089108182` | feat(rules): file and reconcile promotion tasks (#2887) |
| [#2965](https://github.com/aimpact-inc/repo-harness/pull/2965) | `612458470` | fix(cli): remove retired command residue and guide adapter cleanup (#2964) |
| [#2966](https://github.com/aimpact-inc/repo-harness/pull/2966) | `585b53e87` | fix(rules): retain existing promotion parents during reconciliation (#2963) |
| [#2947](https://github.com/aimpact-inc/repo-harness/pull/2947) | `9944d9377` | cleanup: delete four retired compatibility checks and rename AGENTIC_DEV_* to REPO_HARNESS_* |
| [#2968](https://github.com/aimpact-inc/repo-harness/pull/2968) | `532784b25` | feat(operator-web): read-only Rules workspace with candidates and ledger (#2886) |
| [#2967](https://github.com/aimpact-inc/repo-harness/pull/2967) | `c4db28c63` | feat(rules): show promotion task progress in status --tasks (#2888) |
| [#2971](https://github.com/aimpact-inc/repo-harness/pull/2971) | `337cd2846` | fix(operator-web): state the dirty ledger source (#2970) |
| [#2972](https://github.com/aimpact-inc/repo-harness/pull/2972) | `edcfc729b` | fix(rules): preserve repository identity in promotion and status (#2969) |
| [#2973](https://github.com/aimpact-inc/repo-harness/pull/2973) | `15c9aeed0` | feat(worktrees): rh worktrees owns the contract worktree lifecycle (#2864) |
| [#2975](https://github.com/aimpact-inc/repo-harness/pull/2975) | `94db4a030` | feat(arch): move the architecture commands under rh arch (#2871) |
| [#2978](https://github.com/aimpact-inc/repo-harness/pull/2978) | `9608a5cd0` | fix(upgrade): report retired worktree helper scripts (#2974) |
| [#2981](https://github.com/aimpact-inc/repo-harness/pull/2981) | `ff102d23c` | fix(arch): update retired command guidance (#2977) |
| [#2980](https://github.com/aimpact-inc/repo-harness/pull/2980) | `1882f3c78` | feat(evals-checks): expose verification through rh verify (#2865) |
| [#2979](https://github.com/aimpact-inc/repo-harness/pull/2979) | `baf2fe2f6` | test(review): budget slow Intel OAR fixtures (#2976) |
| [#2982](https://github.com/aimpact-inc/repo-harness/pull/2982) | `e5d09c968` | feat(operator): rules_promote and rules_reconcile write routes; the rules snapshot gains tasks, prompts, routes and herdr (#2889) |
| [#2984](https://github.com/aimpact-inc/repo-harness/pull/2984) | `ae846a391` | feat(cli): group capability commands under rh capability (#2866) |
| [#2985](https://github.com/aimpact-inc/repo-harness/pull/2985) | `7499bbc30` | fix(ci): budget and split the Intel acceptance-receipt leg (#2983) |
| [#2987](https://github.com/aimpact-inc/repo-harness/pull/2987) | `8ab7defed` | feat(operator-web): rules candidate drawer, promotion submit and the rules task view (#2890) |
| [#2989](https://github.com/aimpact-inc/repo-harness/pull/2989) | `6e31f2d21` | docs(architecture): name the current writer supervisor command (#2986) |
| [#2991](https://github.com/aimpact-inc/repo-harness/pull/2991) | `6f8016eeb` | fix(operator-web): keep unresolved promotion recovery and stale rules data in the drawer (#2988) |
| [#2992](https://github.com/aimpact-inc/repo-harness/pull/2992) | `8d430e18a` | fix(architecture): anchor the run-helper flow proof on executeHelper (#2990) |
| [#2994](https://github.com/aimpact-inc/repo-harness/pull/2994) | `37b07a0f9` | chore(projection): refresh generated architecture outputs for main@8d430e18a2c8 |
| [#2995](https://github.com/aimpact-inc/repo-harness/pull/2995) | `2aad37197` | fix(architecture): match run-helper labels to execution (#2993) |
| [#2999](https://github.com/aimpact-inc/repo-harness/pull/2999) | `e7bb9b1a1` | fix(release): count only operator setup modules in tarball smoke (#2998) |

## Verification

On Darwin arm64 with Bun 1.4.4, at source `2aad37197` with the release prep commits through `621b840ac`. After the rebase onto `e7bb9b1a1` (#2998 changes one line of `scripts/check-tarball-install-smoke.sh`), `check:type`, the skill version check, the changelog check, `check:cli-manifest` and `git diff --check` pass again:

- `bun install --frozen-lockfile`: pass, no changes.
- `bun run check:type`: pass, exit 0.
- `bun run check:state-boundaries`: pass, 652 TypeScript files checked.
- `bun scripts/check-skill-version.ts`: pass, repo-harness=0.33.2, template=0.33.2.
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass, 121 released sections keep their bytes.
- `bun run check:cli-manifest`: pass.
- `bun run test:files tests/skill-version.test.ts tests/bootstrap-files.test.ts tests/readme-dx.test.ts tests/action-command-skills.test.ts tests/scaffold-parity.test.ts tests/installed-copy-sync.test.ts --timeout 60000 --max-concurrency 1`: pass, 100 tests in 6 files.
- `git diff --check origin/main...HEAD`: pass.

`Required / CI` and the release gate are pending. The owner release plan runs the release gate after the prep PR merges. Skill eval evidence is unavailable. Consumer architecture smoke evidence is pending; the automated case is `tests/hook-runtime.test.ts`, "a registry consumer without code facts or a projection manifest gets one architecture line (#850)".

## Order of the owner steps

1. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.33.2`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, the orchestrator and the advisor decide the host post-release steps. The owner word does not cover an update of the installed rh on the owner Mac.

## Acceptance environment

Joint decision [#2960 comment 6935908919](https://github.com/aimpact-inc/repo-harness/pull/2960#issuecomment-6935908919) runs the rehearsal once before the merge. The first result is in [#2960 comment 6936188561](https://github.com/aimpact-inc/repo-harness/pull/2960#issuecomment-6936188561).

Release upgrade rehearsal: [run 44003235051](https://github.com/aimpact-inc/repo-harness/actions/runs/44003235051), success on `ubuntu-latest` at prep head `aa1a1c0af`. `scripts/check-release-upgrade-rehearsal.sh` requires `RUNNER_TEMP` and refuses a workstation, so it ran as lane `release-rehearsal` of `probe.yml`. The later commits change the smoke script and this record only.

- `[rehearsal] OK: 0.33.1 -> 0.33.2`
- `TARBALL SERVED repo-harness 0.33.2`
- `TARBALL SERVED repo-harness-operator-web 0.33.2`

Tarball install smoke: `bash scripts/check-tarball-install-smoke.sh` on Darwin arm64, Bun 1.4.4, with its own mkdtemp HOME under `/tmp`.

- At `aa1a1c0af`: fail, `operator serve with selection [] returned 1, 0 stdout bytes and 1 Operator modules`. The loaded module was the core file `src/cli/commands/setup-check.ts`, which the smoke regex counted as Operator code after #2863 renamed it. #2998 narrows the regex.
- At source `e7bb9b1a1` with the release prep commits: pass, exit 0. `mcp serve loads 33 MCP modules with all, 0 with selection []`; `operator serve loads 80 Operator modules with all and serves; with selection [] it refuses`; `peer-runtime loads 4 modules when selected`; `repo-harness-0.33.2.tgz installs, serves the packaged Operator, and packaged CLI bins start`.

Command probe at `aa1a1c0af`: both 0.33.2 tarballs installed into a fresh mkdtemp HOME with an `all` plugin selection.

- `rh --version` prints `0.33.2`.
- `rh worktrees status`, `rh verify --help`, `rh capability context status`, `rh arch projection status --json` and `rh arch codegraph --help` answer. `rh verify plan validate` reaches its helper (`--repo is required`, exit 2).
- `rh run contract-worktree`, `rh run verify-sprint` and `rh run capability-resolver` exit 2 with the replacement command.
- `rh capability-context`, `architecture-projection`, `architecture-debt`, `module`, `refactor`, `tools`, `brain`, `migrate` and `init-hook` exit 1 with `unknown command`.
- `rh verify --help` prints the helper usage under the name `verify-sprint`.

No step used the real HOME. No step published to npm or created a tag.

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.33.2` | pending | pending | pending |
| 2 | `repo-harness@0.33.2` | pending | pending | pending |

Publish both packages, create tag `v0.33.2` and create the GitHub Release: pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.33.2` and `bash scripts/release-owner-steps.sh check tagged 0.33.2`: pending.
- Rebuild released managed values in the post-release PR: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction.
