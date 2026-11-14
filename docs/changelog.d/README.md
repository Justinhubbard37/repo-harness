# Changelog fragments

Each PR writes its changelog entry in one file: `docs/changelog.d/<issue>.<category>.md`.

- `<issue>` is the issue number of the PR.
- `<category>` is one of `breaking`, `added`, `changed`, `fixed`, `removed`, `documentation`, `tests`, `upgrade`, `rollback`.
- The file holds one or more `- ` entry lines and no other text.

Release prep is one PR. Put the CHANGELOG section, the version bumps and the release checklist in that PR. The changelog check treats every version heading on the base as released, even without a tag. A section merged earlier cannot be edited in the release prep PR.

The release prep runs `bun scripts/changelog-fragments.ts assemble --version <x.y.z> --date <YYYY-MM-DD>`. It writes the released section of `docs/CHANGELOG.md` and deletes the fragments. It keeps this file, so git keeps the directory.
