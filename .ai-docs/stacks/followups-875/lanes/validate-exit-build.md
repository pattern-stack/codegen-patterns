# Lane `fu-validate-exit` — `entity validate` exits non-zero when validation fails

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-fix-entity-validate-exit`
- **Branch:** `dugshub/fix-entity-validate-exit`, off `origin/main`.

## The problem

`codegen entity validate` (`src/cli/commands/entity.ts`, the validate command around `validateEntities` /
`analyzeDomain`) exits 0 even when validation reports errors. `--json` carries `valid: false`, but the exit code ignores
it. Found while building #915. CI and scripts that rely on the exit code therefore pass on an invalid project.

## Fix

- Exit non-zero (the CLI's existing error exit code: find how other commands signal failure, and reuse it) whenever
  validation reports an error, in text mode and in `--json` mode. Warnings alone keep exit 0, if the command
  distinguishes them.
- Check whether `project inspect --kind analyze` (or any other validate-like command) has the same bug, and fix it the
  same way if so. Say which.

## Tests

- A CLI test: an invalid entity YAML makes `entity validate` exit non-zero (text and `--json`), and a valid project
  exits 0. Show the non-zero case red on the old code (it exits 0), then green.
- Update any existing test that asserted exit 0 on an invalid project. That is an assertion change, so name it in your
  report.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`. Commit on the branch, do not push. Report to `codegen-patterns-73`.
