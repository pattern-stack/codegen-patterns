# Lane `fu-tmpdir` — one test run must never delete another run's temp directory

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-fix-orchestration-tmpdir`
- **Branch:** `dugshub/fix-orchestration-tmpdir`, off `origin/main`.

## The problem

`src/__tests__/patterns/validate-orchestration.test.ts` (around lines 290–305) cleans up by deleting **every** entry in
`os.tmpdir()` whose name starts with its prefix. When two `test-all` runs execute in parallel on the same machine (in two
worktrees, say), one run deletes the other's live temp directory. The other run then fails "loadAppPatterns —
duplicate-name detection > two orchestration fixtures with the same name". This was seen twice during the #875 build.

## Fix

- Each run creates its own directory with `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))` and deletes **only
  that one** (`afterEach` / `afterAll`).
- Remove the prefix sweep entirely. If the sweep existed to clean leftovers from crashed runs, say why that is not
  needed, or keep a sweep that only deletes entries older than a safe age, and state that age. Prefer no sweep.
- Then `grep -rn "readdirSync(os.tmpdir())\|readdirSync(tmpdir())" src test` for the same pattern elsewhere, and fix
  every hit the same way.

## Gate: show it can fail

Write a small throwaway script that runs the test file twice concurrently, 10 times in a loop. On the old code it should
fail at least once; on the new code it must pass 10 out of 10. Paste both runs. Do not commit the script.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`. Commit on the branch, do not push. Report to `codegen-patterns-73`.
