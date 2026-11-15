# repo-harness 0.33.1 publication record

## Release scope

- Release date: UTC 2026-11-15. Parent #2742; release issue [#2793](https://github.com/aimpact-inc/repo-harness/issues/2793).
- The owner authorized this release with “现在发0.33.1” on 2026-11-15. The issue records the word and its time.
- Source commit before release prep: `1b586d8d0551899ff0d0b30a987c0386861ecd3f`. The release range is `v0.33.0..1b586d8d0`.
- The 2770 fragment corrects the archctx version named in the 0.33.0 section. That section remains unchanged.

| PR | Commit | Change |
|---|---|---|
| [#2728](https://github.com/aimpact-inc/repo-harness/pull/2728) | `83c6fb86f` | Refresh the architecture projection. |
| [#2789](https://github.com/aimpact-inc/repo-harness/pull/2789) | `3a5d4015f` | Rebuild released managed values for v0.33.0. |
| [#2785](https://github.com/aimpact-inc/repo-harness/pull/2785) | `20e681bdd` | Correct pinned archctx guidance. |
| [#2787](https://github.com/aimpact-inc/repo-harness/pull/2787) | `0e2db9d93` | Specify the reviewed CI owner drift surface. |
| [#2786](https://github.com/aimpact-inc/repo-harness/pull/2786) | `74c0c4abc` | Resolve hoisted archctx for daemon checks. |
| [#2790](https://github.com/aimpact-inc/repo-harness/pull/2790) | `75f47219a` | Document release prep and the post-release rebuild. |
| [#2791](https://github.com/aimpact-inc/repo-harness/pull/2791) | `2a22fab75` | Report the retired Pi extension protocol. |
| [#2792](https://github.com/aimpact-inc/repo-harness/pull/2792) | `1b586d8d0` | Resolve the review threads confirmed by receipt protocol 2. |

## Verification

On Darwin arm64 with Bun 1.4.4, at source `1b586d8d0` with the release prep changes:

- `bun install --frozen-lockfile`: pass, 521 packages installed.
- `bun run check:type`: pass.
- `bun run check:state-boundaries`: pass, 625 TypeScript files checked.
- `bun run test:files tests/skill-version.test.ts tests/bootstrap-files.test.ts tests/readme-dx.test.ts --timeout 60000 --max-concurrency 1`: pass, 35 tests.
- `bun run test:files tests/action-command-skills.test.ts --timeout 60000 --max-concurrency 1`: pass, 33 tests.
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass for the committed base. A separate byte comparison confirms that all earlier sections in the worktree match `origin/main`.
- `git diff --check`: pass.

`Required / CI` and the release gate are pending. The owner release plan runs the release gate after the prep PR merges. Skill eval evidence is unavailable. Consumer architecture smoke evidence is pending; the automated case is `tests/hook-runtime.test.ts`, “a registry consumer without code facts or a projection manifest gets one architecture line (#850)”.

## Order of the owner steps

1. Merge the prep PR under the applicable rule after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.33.1`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, update the owner Mac as authorized in #2793: `bun add -g repo-harness@0.33.1 --no-cache`, then `rh update --version 0.33.1`. Pi stays at 1.5.2.

## Acceptance environment

Release upgrade rehearsal: [run 43661211783](https://github.com/aimpact-inc/repo-harness/actions/runs/43661211783), success on `ubuntu-latest` at prep head `223d15646`.

- `[rehearsal] OK: 0.33.0 -> 0.33.1`
- `TARBALL SERVED repo-harness 0.33.1`
- `TARBALL SERVED repo-harness-operator-web 0.33.1`

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.33.1` | pending | pending | pending |
| 2 | `repo-harness@0.33.1` | pending | pending | pending |

Publish both packages, create tag `v0.33.1` and create the GitHub Release: pending. The owner Mac update is pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.33.1` and `bash scripts/release-owner-steps.sh check tagged 0.33.1`: pending.
- Record the host version after the upgrade: pending.
- Rebuild released managed values in the post-release PR: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction.
