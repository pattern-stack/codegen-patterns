# Gate 2.5 fixes — one #875 stack PR

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you
(public repo, no sub-agents, never push / PR / merge, gates after the last edit). Your prompt names the PR, the
worktree, the branch and the branch below it.

## Input

Two Gate 2.5 reviews of your PR, already posted on it:
`/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/gate25/<PR>-adherence.md` and `<PR>-quality.md`.
Read both in full. The PR's earlier review history is on the PR (`gh pr view <PR> --comments`).

## What to do

1. **Fix every blocker and every should-fix** in both reviews, **except items marked `DECISION`**. Those wait for Doug.
   Do not touch them, and list them in your report as "pending decision".
2. **Fix a nit if it is cheap** (minutes, no behaviour change outside this PR). List the rest as "nit, not fixed",
   each with a one-line reason.
3. **Re-verify each finding before you fix it.** If a finding is wrong at the tip, do not "fix" it. Record it as
   "declined: <why>", with the evidence.
4. **Fix in the right branch.** A defect is fixed in the branch that introduced it. The exception: a higher slice in
   the stack rewrites that code. Check with `git log` on the higher branches, or ask the coordinator. Then the fix goes
   there; record "moved to <PR>" and tell the coordinator. Do not edit any other branch yourself.
5. **Each fix that changes behaviour gets a test that fails without it.** Show it red, then green. Cross-slice
   scenarios (a reviewer reproduced something on a fixture) get a fixture or CLI test.
6. **The RFC is living documentation.** Every finding about RFC / CLAUDE.md / spec drift is fixed in the same commit
   as the code it describes. A change to a §11.1 decision is a `DECISION`, not yours.
7. **Commit** on your branch: one commit per review lens, or one per finding group. Use clear messages
   (`fix(#875 S<n>): Gate 2.5 — …`). The stack lands squash-merged.

## Gates (after your last edit; paste the tails)

`bun run typecheck`, `just test-unit`, `just test-baseline`. Run `just test-studio` if you touched `tools/studio` or
`src/studio`, and `just test-smoke-frontend` if you touched the frontend emitter. The coordinator runs `test-all` and
`test-integration` after the cascade.

## Report

`SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`), as a table with one row per finding:
`PR / lens / # / severity → fixed in <sha> | moved to <PR> | declined: why | pending decision | nit, not fixed: why`.
Include the gate tails. This table becomes the reply on the PR, so keep it accurate and free of host-application
names.
