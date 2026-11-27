# Lane `fu-915-build` — #915: an invalid entity YAML is a named rejection, not a silent skip

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-915-barrels-invalid-yaml`
- **Branch:** `dugshub/915-barrels-invalid-yaml`, off `origin/main`.
- **Issue:** `gh issue view 915`.

## The problem

When one entity YAML fails schema validation, the cross-entity post-steps skip that entity without saying so: the
barrels in `src/cli/shared/barrel-generator.ts` and the relations manifest in `src/cli/shared/relations-generator.ts`.
The run then fails far from the cause, with about 20 unrelated `tsc` errors instead of the one validation error.

## What to do

1. **Find every place** a whole-set step loads the entity directory and drops an entity that fails to parse or validate.
   That includes the barrels, the relations manifest and anything else `entity new` / `junction new` /
   `relationship new` / `project` commands run over the set. Look for a `catch`, a filter, or a "skip if invalid".
   List each with `path:line` in your report.
2. **Make an invalid entity a run-level rejection reported by name**, through the existing mechanism
   (`runRejections` in `src/cli/shared/entity-render.ts`), not a parallel one. The post-steps must never run over a
   set that silently lacks an entity. Design the error message the way the existing validation errors are written
   (entity, file, the issue's path and message).
3. **Gate:** a CLI test where one YAML in a directory is invalid. Assert:
   - the run fails, naming that entity and its validation error;
   - no barrel or manifest is written over the partial set;
   - an `--all` run, a single-target run, and a run that targets a *different*, valid entity in the same directory all
     behave this way.

   Show it red against today's code, then green.
4. If the baseline harness (`test/run-test.ts`) or a smoke runner has its own skip, fix it the same way, or say why
   it is safe.
5. Update CLAUDE.md or the relevant spec only where they describe this behaviour.

## Gates (after your last edit; paste the tails)

`bun run typecheck`, `just test-unit`, `just test-baseline`, the whole `just test-all`.

## Report

Per COMMON.md, to `codegen-patterns-73`.
