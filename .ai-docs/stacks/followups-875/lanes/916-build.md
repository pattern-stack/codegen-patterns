# Lane `fu-916-build` — #916: the flaky timestamptz T4 test

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-916-timestamptz-t4`
- **Branch:** `dugshub/916-timestamptz-t4`, off `origin/main`.
- **Issue:** `gh issue view 916`.

## The problem

`test/scaffold/tests/timestamptz.test.ts`, the test "T4: a database-side comparison under a non-UTC session agrees",
failed once and then passed on an unchanged re-run, in two separate lanes. It asserts
`created_at <= now() and created_at > now() - interval '1 minute'` on a row just created through the generated
repository.

## What to do

1. **Find the cause first, from code.** Where does `created_at` get its value on that insert? Is it the application's
   clock (the `timestamps` behaviour / `withTimestamps` in `runtime/base-classes/`, or the repository's create), or the
   database's `defaultNow()`? Compare the clock that stamps the row with the clock that `now()` reads. If you can
   reproduce the failure (for example by skewing the app clock in a scratch test), do, and paste the output.
2. **Decide the fix by what the test exists to prove** (read its header and the T0–T6 set: #796, timestamptz
   correctness under a non-UTC session).
   - If `created_at` is stamped by the app clock **by design**, make T4 assert its property without depending on two
     clocks agreeing. For example, compare against a bound the test captures from the same clock, or a database-side
     value read back.
   - If stamping `created_at` from the app clock is itself a **defect** (the column has `defaultNow()` and the runtime
     overrides it), **stop and report** before changing runtime behaviour. That is a behaviour change for every entity
     with timestamps, and it is the coordinator's call.
3. **Gate:** T4 must still fail on its subject. Show it going red when the timestamptz property it guards is broken (for
   example, the column emitted as `timestamp` without a time zone, or the session-zone handling removed), and green
   otherwise. Run the timestamptz file 20 times in a row and report the pass count.

## Gates (after your last edit; paste the tails)

`bun run typecheck`, `just test-unit`, `just test-integration` (run the timestamptz file 20× separately), and the whole
`just test-all`.

## Report

Per COMMON.md, to `codegen-patterns-73`, with the cause, the evidence and which branch of step 2 you took.
