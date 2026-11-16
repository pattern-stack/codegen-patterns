# Lane `fu-918-rebase` — rebase #915 (PR #918) onto `main` @ `800f4150`

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first; it binds you.
Never push.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-915-barrels-invalid-yaml`
- **Branch:** `dugshub/915-barrels-invalid-yaml`, which is PR #918.

The branch was built on the `main` from before #875's stack (#907–#912) merged as `800f4150`. GitHub now reports
conflicts.

1. Back up the branch: `git branch -f backup/915-pre-rebase HEAD`. Run `git fetch origin`, then
   `git rebase origin/main`. If it stops on the same conflicts commit after commit, you may instead apply the whole
   `origin/main...HEAD` diff once with `git apply --3way` on a fresh branch reset to `origin/main`. The PR is
   squash-merged.
2. **Resolve every conflict by keeping both intents.**
   - #915's intent: an invalid definition is a named run-level rejection, through `definitionSetRejections`; every
     whole-set loader throws `InvalidDefinitionError` instead of skipping; one rule for which files are entities,
     `listEntityYamls(dir, nonEntityDirs)` with `nonEntityDirs` required; `codegen init` seeds `entities/README.md`;
     `relationshipsDirFor`.
   - #875's intent: joined-table inheritance. It changed `src/cli/shared/entity-render.ts` (pre-flight, inheritance
     counterparts, rejections), the loaders, `load-entities.ts`, the derivation, the templates, and many fixtures and
     goldens.
   - Any new whole-set loader that #875 added must also go through `listEntityYamls` and throw on an invalid file, so
     that #915's rule holds over the merged code. Grep for new directory walks.
   - #875's new fixture directories (inheritance, scaffold, smoke families, and the `test/smoke/fixtures` parcel/crate)
     must still be read correctly under `nonEntityDirs`.
3. Regenerate goldens and snapshots with the repo's own update flags. Do not hand-merge them, and explain every
   regenerated diff.
4. **Gates, after the last edit:** `bun run typecheck`, `just test-unit`, `just test-baseline`, the whole
   `just test-all`, and `just test-integration`. All must be green, with a clean tree.

Report to `codegen-patterns-73`: each conflict and how you resolved it, any new walk you brought under the rule, and
the gate tails.
