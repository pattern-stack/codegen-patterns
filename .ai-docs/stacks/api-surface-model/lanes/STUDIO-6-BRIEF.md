# Lane brief — STUDIO-6: a spine-order toggle, and a floating-inheritance prototype

You are a **build lane for one PR** off `main`, owner-approved 2026-11-15. Two other Studio PRs are in flight (STUDIO-5
selectors, an API-tab fix) in other worktrees. Don't touch them. Whichever PR lands second rebases.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-6-spine-order`, branch
  `dugshub/studio-6-spine-order`, on `main` @ `a86e3a3d`. Run `mise trust && just install` first.
- **Lead:** session `dugshub-api-surface-a0-1e` (hc `t1t9`). It may hand off. If `SendMessage` to it fails, use
  `ListAgents` and send to `codegen-patterns-7f` instead.
- **Read first:** `CLAUDE.md` § Studio (the spine rule, secondary lines, packing, docking); `tools/studio/src/graph/spine.ts`
  (`chooseSpines`); `layout/tree-layout.ts`.

## The problem

STUDIO-3's spine rule ranks `inherits` above an owning `belongs_to` with `on_delete: cascade`.

Take this shape:
- a base `part`, with a discriminator `kind`;
- `audio_part`, which inherits `part` and `belongs_to: recording` (cascade);
- `text_part`, which inherits `part` and `belongs_to: message` (cascade).

Today both children hang under `part`, and `recording → audio_part` and `message → text_part` are secondary lines. So
the ownership tree can't be read.

## The asks (do not widen them)

1. **A spine-order toggle.**
   - **Inheritance first** (the default; today's rule): `inherits` > unique FK > cascade > first declared. Verify
     today's exact order in `spine.ts`.
   - **Ownership first**: owning `belongs_to` with `on_delete: cascade` > `inherits` > unique FK > first declared.
   - The rule stays in **one place**: `graph/spine.ts`, parameterised by the order. No second copy.
   - Show the active order in the header.
   - Remember it per browser (`localStorage`, key `studio.spineOrder`, every access in `try/catch`, the same way
     `panels.ts` / `theme/use-theme.ts` do).
   - The spine reason still rides on each line (`treeReason`) and reads correctly under both orders.
2. **A prototype, in ownership-first mode only: inheritance "floats".**
   - Instead of a long line from each child to a shared base card, each child shows a small **base chip** or ghost card
     next to it ("is a Part"), one per child.
   - Clicking the chip selects and reveals the real base card. That card still appears **once**, where its own spine
     places it.
   - This is **exploratory**: the owner decides at sign-off whether to keep it. Keep it **contained and easy to
     delete**: one component and one flag. Say in your report exactly which files and lines deleting it touches.
   - Decide how the floated inherits lines are drawn (hidden, or kept faint) and state the choice. Either way they stay
     out of the layout.
3. **Keep:**
   - the spine reason on each line;
   - secondary lines excluded from the layout, so adding an FK moves no card.
   - The existing tests must stay green **unchanged**. In particular, the "adding or removing a secondary line moves
     no card" tests stay as they are.

## Tests

- The spine choice for the part / audio_part / text_part shape:
  - under **inheritance first**, both children's spine is `part`;
  - under **ownership first**, the spines are `recording` and `message`, and the reasons are correct in both cases.
- **Mutation:** ignore the order (always inheritance first) → a test goes red. Paste the red line, then revert.
- **Toggle persistence:**
  - load falls back to inheritance first when storage throws or holds garbage;
  - store round-trips.
  - Put this in a pure function beside the toggle, as `panels.ts` does.
- **Fixture:** add the small generic family (`part`, `audio_part`, `text_part`, `recording`, `message`) under
  `tools/studio/src/__tests__/fixtures/`. If a YAML fixture is clearly better, use `test/fixtures/`, and give the
  reason.

## Sign-off page (you build the HTML; the lead publishes)

**Shots of BOTH modes**, light and dark, at 1440×900, with the floating chip visible in ownership-first:
- on the small five-entity model;
- on a larger model: the joined-table-inheritance fixture (`test/fixtures/inheritance/`, copied to your scratchpad as a
  project), or the demo.

Running Studio:
- `just studio <dir> 6477 6478`, with the browser on the **server port 6477**, never the Vite port (Vite's `/api`
  goes to 5178, another session's server).
- Check `/api/health` `projectDir` before shooting.
- Don't touch hc `studio-900` or ports 5977/5978.
- Stop the server afterwards.

**The page:**
- One HTML file in your scratchpad, in the style of
  `/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-api-surface-a0/e4d7824a-677e-46d0-8d28-c17dcb28583a/scratchpad/s7/build_studio4.py`
  (read it, then copy its approach), via a builder script.
- `<title>Studio Spine Order</title>`.
- Sections: the toggle and the two orders; the shots; the prototype, with its delete path; your decisions; gates and
  mutations.
- Report the builder's and the page's paths; don't publish.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave the work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names or
  "dogfood" references in code, comments, tests, fixtures or docs; say "a host application". Fixtures use generic
  names: the five above.
- **Scope:** `tools/studio/src/**`, `CLAUDE.md` § Studio and `docs/specs/STUDIO-0.md`, plus a fixture under `test/fixtures/` only
  if you justify it.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. List any changed pre-existing assertion
  (none is expected).
- Tokens only. **Stop and report** on any design question this brief doesn't answer. Two failed attempts at the same
  gate is also a stop.

## Exit (final tree)

1. `just test-studio` → 0. Report the UI test total.
2. `git diff -- tools/studio/src/__tests__ | grep -n '^-.*expect('` → no output.
3. Colour-literal grep over the diff → no output, or issue references only.
4. The mutation's red line.

## Report

Short:
- Files changed.
- Each exit step → the deciding line.
- The mutation.
- Your decisions.
- The prototype's delete path.
- The page path.
- Anything you could not do.

Then stop and wait.
