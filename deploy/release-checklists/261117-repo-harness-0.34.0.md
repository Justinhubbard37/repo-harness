# repo-harness 0.34.0 publication record

## Release scope

- Release date: UTC 2026-11-17. Parent [#2742](https://github.com/aimpact-inc/repo-harness/issues/2742); no separate release issue.
- Owner word, relayed locally by the advisor seat and recorded in [#2742 comment 6944213200](https://github.com/aimpact-inc/repo-harness/issues/2742#issuecomment-6944213200) at 2026-11-17T09:34:08Z: "發 0.34.0 (Recommended)", the answer at 17:33 (+08) to the question "release 0.34.0 from main 0ec0c7c0b90b3753f1e511421f7af080005efa61".
- Source commit before release prep: `0ec0c7c0b90b3753f1e511421f7af080005efa61`. The release range is `v0.33.2..0ec0c7c0b`: 25 commits and 6 changelog fragments (`2815.added`, `2818.added`, `2844.changed`, `2916.changed`, `2916.removed`, `3004.changed`) plus the kept `README.md`. Main merges are frozen until this PR merges.
- #2926 (#2916), #2898, #2922, #2894 and #2893 stayed out of 0.33.2 by the owner words recorded in the 0.33.2 publication record. They ship in this release.
- No fragment is `breaking`. Release prep added the `### Breaking` section with one `Migration:` line for each removed name that a user configured or that a shipped v0.33.2 document named: the `operations.agent_writable_private_dirs` policy key and the five deleted guard names (#2916, named in `README.md`, `docs/usage.md` and `hook-operations.md` at v0.33.2), and the seats key `routing.codex_hyper_at_or_above_remaining` (#3004; `decodeSeatsConfig` refuses a stored section that holds it with `seats_config_migration_required` until `rh update` removes it). No command, helper id or environment variable leaves the CLI in this range: `src/cli/commands/` changes only `global-runtime.ts`, and no `REPO_HARNESS_*` name leaves `src`, `scripts` or `assets`. The #2844 move of the runtime-state block stays in Changed, because `rh update` moves it.
- Release prep corrections in the new section:
  - The #2815 entry said that a consolidation keeps every `Promoted` reference. #3032 limits this to the entries that the consolidation replaces, #3029 checks the metadata on the consolidated entry, and #3024 allows a same-day `Seen` raise on the latest entry and finds a consolidation that adds a new event. The entry now says so.
  - #3025 (#3019) and #3040 (#3026) change the I2 judge that #2926 adds in this same range. The bugs never shipped, so release prep wrote one Changed entry with the final behavior and no Fixed entry.
  - #3030 (#3020) reports the backup that #3015 (#3011) adds in this range, so both share one Fixed entry.
- Release prep added one entry, from the merged PR, for each user-visible change without a fragment: #3000 (#2874, Added); #3025 and #3040 (#3019, #3026, Changed); #3007 (#3005, Changed); #3015 and #3030 (#3011, #3020, Fixed); #3028 (#3017, Fixed); #3014 (#3012, Fixed, as the 0.33.2 entry for #2793).
- Commits without an entry, and why:
  - #3024, #3029, #3032: they correct the `LedgerEnforcement` check that #2894 adds in this range; the corrected #2815 entry holds their final behavior.
  - #2898: new files only; no caller uses the host-config gate yet.
  - #3010: changes only the printed step of the repository's own release plan, the same class as the release smoke fix #2998 in 0.33.2.
  - #3021: test fixture only.
  - #2996, #3039: generated architecture projection only.
  - #3036: architecture model and map only.
  - #3035: PRD only.
  - #3016, #3023: root instruction files and the lessons ledger of this repository only.

| PR | Commit | Change |
|---|---|---|
| [#2926](https://github.com/aimpact-inc/repo-harness/pull/2926) | `9d369af41` | feat(hook): one safety hook enforces I1/I2 and replaces the text-pattern guards (#2916) |
| [#3007](https://github.com/aimpact-inc/repo-harness/pull/3007) | `969500fc8` | fix(seats): accept additional Pi models (#3005) |
| [#3008](https://github.com/aimpact-inc/repo-harness/pull/3008) | `0849fe2c8` | fix(seats): remove ChatGPT hyper model promotion (#3004) |
| [#3014](https://github.com/aimpact-inc/repo-harness/pull/3014) | `9f49a0d41` | fix(release): rebuild released managed values for v0.33.2 (#3012) |
| [#2893](https://github.com/aimpact-inc/repo-harness/pull/2893) | `f1ed65a33` | feat(publication): merge readiness consumes the TestBudget result and refuses a stale one (#2818) |
| [#3000](https://github.com/aimpact-inc/repo-harness/pull/3000) | `3f53fd6e4` | feat(architecture): show task posture at SessionStart (#2874) |
| [#2894](https://github.com/aimpact-inc/repo-harness/pull/2894) | `fab721371` | feat(ci): LedgerEnforcement on the lessons ledger feeds Required / CI (#2815) |
| [#3016](https://github.com/aimpact-inc/repo-harness/pull/3016) | `b66feb7eb` | docs(instructions): use policy as budget authority (#2819) |
| [#2898](https://github.com/aimpact-inc/repo-harness/pull/2898) | `6ff2249ce` | feat(host-config): two-level ledger, transaction record and recovery (#2846) |
| [#2922](https://github.com/aimpact-inc/repo-harness/pull/2922) | `512a39f0c` | feat(installer): the runtime-state block goes to each adopted repository's .git/info/exclude (#2844, P-b) |
| [#3010](https://github.com/aimpact-inc/repo-harness/pull/3010) | `b90a4be5d` | fix(release): use rh in post-release update (#3009) |
| [#2996](https://github.com/aimpact-inc/repo-harness/pull/2996) | `27dc243cc` | chore(projection): refresh generated architecture outputs for main@512a39f0ce51 |
| [#3021](https://github.com/aimpact-inc/repo-harness/pull/3021) | `6440a073d` | test(archctx): retry fixture cleanup on Windows (#3018) |
| [#3024](https://github.com/aimpact-inc/repo-harness/pull/3024) | `26c14440f` | fix(ledger): allow same-day Seen raises and detect mixed consolidation (#2938) |
| [#3015](https://github.com/aimpact-inc/repo-harness/pull/3015) | `c96e63989` | fix(update): back up global config before migrations (#3011) |
| [#3023](https://github.com/aimpact-inc/repo-harness/pull/3023) | `203bf9d1c` | docs(ledger): promote the ten carried themes (#2900) |
| [#3029](https://github.com/aimpact-inc/repo-harness/pull/3029) | `d1a0d6714` | fix(ledger): preserve metadata on the consolidated entry (#3027) |
| [#3030](https://github.com/aimpact-inc/repo-harness/pull/3030) | `6f11221a5` | fix(update): report candidate configuration backup (#3020) |
| [#3032](https://github.com/aimpact-inc/repo-harness/pull/3032) | `e83dc0ea9` | fix(ledger): scope promotions to replaced entries (#3031) |
| [#3028](https://github.com/aimpact-inc/repo-harness/pull/3028) | `ee3ee22d3` | fix(architecture): keep notice deadlines and delivered markers (#3017) |
| [#3035](https://github.com/aimpact-inc/repo-harness/pull/3035) | `3a3d9e5ba` | docs: add rules review and promotion PRD |
| [#3036](https://github.com/aimpact-inc/repo-harness/pull/3036) | `54bc6a17b` | docs(architecture): refresh command and rules map (#3034) |
| [#3025](https://github.com/aimpact-inc/repo-harness/pull/3025) | `bb427ee2c` | fix(hook): expand glob and brace operands in-process and judge every match with one rule (#3019) |
| [#3039](https://github.com/aimpact-inc/repo-harness/pull/3039) | `7b01a9c9f` | chore(projection): refresh generated architecture outputs for main@bb427ee2c515 |
| [#3040](https://github.com/aimpact-inc/repo-harness/pull/3040) | `0ec0c7c0b` | fix(hook): refuse a writing find that follows links as an unknown target (#3026) |

## Verification

On Darwin arm64 with Bun 1.4.4, at prep head `12d5094bc` on source `0ec0c7c0b`:

- `bun install --frozen-lockfile`: pass, no changes.
- `bun run check:type`: pass.
- `bun scripts/check-skill-version.ts`: pass, repo-harness=0.34.0, template=0.34.0.
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass, 122 released sections keep their bytes.
- `bun run check:cli-manifest`: pass.
- `git diff --check origin/main...HEAD`: pass.
- `bun run test:files tests/skill-version.test.ts tests/bootstrap-files.test.ts tests/readme-dx.test.ts tests/scaffold-parity.test.ts tests/installed-copy-sync.test.ts --timeout 60000 --max-concurrency 1`: pass, exit 0, 67 tests in 5 files (13, 17, 5, 2 and 30), 0 fail.

`Required / CI` is pending. The owner release plan runs the release gate after the prep PR merges.

## Order of the owner steps

1. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.34.0`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, the orchestrator and the advisor decide the host post-release steps. The owner word does not cover an update of the installed rh on the owner Mac. When the installed rh moves to 0.34.0, run `rh update --version 0.34.0` right after the package install and before a seat relaunch or an `rh quota` read: a seats section saved by 0.33.2 holds `routing.codex_hyper_at_or_above_remaining` (its default was 50), and `rh quota` and `rh seats argv` refuse it with `seats_config_migration_required` until `rh update` removes it (#3004).

## Acceptance environment

Joint decision [#2742 comment 6944241312](https://github.com/aimpact-inc/repo-harness/issues/2742#issuecomment-6944241312) runs `bash scripts/check-tarball-install-smoke.sh` with a mkdtemp HOME once, at the frozen release PR head after the version and CHANGELOG commits.

Tarball install smoke: `bash scripts/check-tarball-install-smoke.sh` on Darwin arm64, Bun 1.4.4, at prep head `12d5094bc` (the version and CHANGELOG commit), with an outer HOME from `mktemp -d /tmp/rh034-smoke-home.XXXXXX` and the script's own mkdtemp HOME and registry under `/tmp`: pass, exit 0.

- `mcp serve loads 33 MCP modules with all, 0 with selection []; status --json loads 0.`
- `operator serve loads 80 Operator modules with all and serves; with selection [] it refuses, and status, seats, quota and hook routes load 0; the hook bundle of 134 modules holds 0.`
- `peer-runtime loads 4 modules when selected; refusals, core commands, hook routes and hook bundle load 0.`
- `repo-harness-0.34.0.tgz installs, serves the packaged Operator, and packaged CLI bins start.`

The commits after `12d5094bc` change only this record. No step used the real HOME. No step published to npm or created a tag.

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.34.0` | pending | pending | pending |
| 2 | `repo-harness@0.34.0` | pending | pending | pending |

Publish both packages, create tag `v0.34.0` and create the GitHub Release: pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.34.0` and `bash scripts/release-owner-steps.sh check tagged 0.34.0`: pending.
- Rebuild released managed values in the post-release PR: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction.
