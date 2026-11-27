# Lane brief — Studio bug: a long origin chip squeezes the API tab's signature to one letter per line

You are a **build lane for one small PR** off `main`, owner-reported on 2026-11-15.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-api-chip`, branch
  `dugshub/studio-api-chip-wrap`, on `origin/main` @ `a86e3a3d` (0.34.0). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage`; if that doesn't
  resolve, use `ListAgents` and look for a name starting `dugshub-api-surface-a0-`.

## The bug

In Studio's API tab (`tools/studio/src/inspector/surface-rows.tsx`, `ApiTab.tsx`), each row shows a method's
signature beside its origin chip. When the chip is long, the signature column collapses:

- The owner's row is `upsertByNaturalKey(input, tx) → one`, with the chip
  `← unique_indexes[0].natural_key (<entity>'s natural key, …)`.
- The signature wraps one character per line.
- The chip runs past the panel's right edge.

## The fix (do not widen it)

- **The signature column keeps its width.**
  - `flex: 1 1 auto`, with a `min-width` set so it never collapses to a letter.
  - It wraps only at word or argument boundaries, never inside a word.
- **The chip never overflows the panel.**
  - Give it a `max-width` and truncate it with an ellipsis. The full text goes in a `title` tooltip.
  - Or wrap it onto its own line under the signature when the panel is narrow.
  - Pick one, say which, and keep it simple.
  - It stays clickable as today (an origin chip opens the YAML at its line).
- **Tokens only:** no colour literals; spacing from `--sp-*`.

## Test (red on today's code first)

- Add a unit test (Testing Library, as in `__tests__/surface-error.test.tsx`) or an e2e check. Look at what Studio's
  e2e (`just test-studio`) can measure, and choose what can actually see layout.
- **What it must check:** a row whose origin text is about **120 characters** must:
  - keep its signature on **one line** at the default inspector width (**420 px**);
  - keep the chip **inside the panel**: its right edge ≤ the panel's right edge.
- **Order:**
  1. Run it on today's code and paste the red line.
  2. Then fix.
  3. Then green.
- jsdom has no layout. If you use a unit test, it has to assert the CSS that guarantees the behaviour, and you must
  also prove the behaviour in a real browser. Prefer a real-browser check if the Studio e2e harness can render the
  inspector. Report which you did and why.
- **Fixture: generic.** No host-application names anywhere. Build the long origin from the demo or the
  joined-table-inheritance fixtures, e.g. a `unique_indexes[0].natural_key` origin on a generic entity whose label
  makes it ~120 characters.

## Shots

Take light and dark screenshots of the API tab at a 420 px inspector, with the long chip row visible. Do it before
(on today's code, with `git stash` forbidden: capture first, then fix) and after.
- Run Studio on a generic scratch project in your scratchpad: `just studio <dir> 6277 6278`.
- Point the browser at the **server port 6277**, never the Vite port: Vite's `/api` goes to 5178, which is another
  session's server.
- Check `/api/health` `projectDir` before shooting.
- Save the shots in your scratchpad and report their paths. Stop the server afterwards.
- **Don't touch** hc terminal `studio-900` or ports 5977/5978.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave the work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names
  or "dogfood" references in code, comments, tests, fixtures or docs; say "a host application".
- **Scope:** `tools/studio/**`, plus a sentence in `docs/specs/STUDIO-2.md` if it describes the row layout.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. List any changed pre-existing assertion.
- **Stop and report** on any design question this brief doesn't answer.

## Exit (final tree)

1. `just test-studio` → 0. Report the UI test total.
2. The new test is red on today's code (paste the line) and green after.
3. Colour-literal grep over the diff → no output.
4. Mutation: remove the `min-width` (or the chip's max-width) → the new test goes red. Revert.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short:
- Files changed.
- The approach for the chip: truncate or wrap.
- Each exit step → the deciding line.
- The red-then-green lines.
- The mutation's red line.
- The shot paths, before and after, light and dark.
- Anything you could not do.

Then stop and wait.
