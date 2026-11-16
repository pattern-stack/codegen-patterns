# Lane brief — STUDIO-4: wrap the canvas's trees into rows that fit the viewport

You are a **build lane for one PR**, off `main`, a fast follow-up the owner approved on 2026-11-14 after STUDIO-3
(#891, merged). Independent of the ADR-046 Phase B stack.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-4-tree-blocks`, branch
  `dugshub/studio-4-tree-blocks` (checked out on `main` @ `cb44c88e`, which has STUDIO-3's tree layout). Run
  `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## The problem

STUDIO-3 lays each disconnected tree side by side in one long row. A model of two or three trees is therefore wide and
short, and at fit-to-view the cards render too small to read.

## What the owner asked for (do not widen it)

- **Lay out each disconnected tree as a block** (its own tidy tree, exactly as STUDIO-3 lays it out), and **wrap the
  blocks into rows that fit the viewport's aspect ratio** — no single long row.
- **Cards legible at fit-to-view on an 8-entity model.** Take that as: on the demo and on an 8-entity model of two or
  three trees, the laid-out bounding box's aspect ratio is close to the viewport's, so fit-to-view's zoom is not
  dominated by width.
- Everything STUDIO-3 guarantees stays true **inside** a block: one spine parent, child centred under it, siblings side
  by side, roots on top, secondary lines excluded from layout (adding or removing one moves no card), each line on its
  own channel.

Decide and state: the block order (deterministic — e.g. by size, then root name), how blocks pack into a row
(left-aligned, top-aligned), the gap between blocks, and where the target aspect comes from (the canvas container's
size, passed into a pure layout function — no DOM reads inside the layout).

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** No host-application names, paths or table names in code, comments, tests,
  fixtures or docs. Fixtures use generic names of your own.
- **Scope:** `tools/studio/src/**`, plus the doc text that describes the canvas layout (CLAUDE.md § Studio,
  `docs/specs/STUDIO-0.md` / `STUDIO-2.md` where they describe it). Nothing under `src/**`, `templates/**`, any
  `package.json`, any snapshot or golden.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. **Any pre-existing assertion you change
  must be listed in your report with a one-line reason** (STUDIO-3's pinned positions in `tree-layout.test.ts` may move
  if blocks are re-packed — list each, keep them exact).
- **Stop and report instead of inventing** on any design question this brief does not answer. Two failed attempts at
  the same gate is also a stop.

## Exit — run all of this on your final tree, after your last edit

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `just test-studio` → 0 (UI typecheck, UI unit run ` 0 fail`, e2e).
3. Layout tests: with several disconnected trees and a target aspect (say 16:10), blocks wrap into ≥ 2 rows and the
   bounding box's aspect is within a stated tolerance of the target; a single tree is laid out as before; every
   STUDIO-3 invariant still holds inside each block; the layout is deterministic (same input → same positions); adding
   or removing a secondary line still moves no card.
4. **Mutation:** disable wrapping (one row) → the aspect / row test goes red. Revert, `git status --porcelain` back to
   what it was. A second one of your choice.
5. `git diff main -- tools/studio/src/__tests__ src/__tests__ test | grep -n '^-.*expect('` → only lines you list.
6. Run the app on the demo and on a scratch 8-entity two- or three-tree project and report what you saw; the lead
   captures the owner's before/after screenshots.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutations' red lines; every changed pre-existing
assertion with its reason; the decisions you made above; what the click-through showed. Then stop and wait.
