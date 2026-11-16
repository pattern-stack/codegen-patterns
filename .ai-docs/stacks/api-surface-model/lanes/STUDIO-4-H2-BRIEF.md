# Lane brief — STUDIO-4 (part 3): one-card parent trees go in the top row (owner's H2 decision)

You are a **build lane for one change** on the STUDIO-4 PR (#900, open, approved apart from this). The owner decided
H2 on 2026-11-14 as option (b) below. Do this change and nothing else.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-4-tree-blocks`, branch
  `dugshub/studio-4-tree-blocks` @ `2407f2c3`. It was just rebased onto `main` @ `cd03f8f3`; the two STUDIO-4 commits
  are on top. Work on top of them, uncommitted. If a gate says deps are missing, run `mise trust && just install`.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that name. If it
  does not resolve, run `ListAgents` (the name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## Today

`tools/studio/src/layout/tree-layout.ts`:
- `treeLayout` lays each disconnected tree (spine lines only) out as a **block**.
- It sorts the blocks biggest first (most cards, then root id).
- `packBlocks` wraps them into left-aligned rows. It picks the row width whose packing fit-to-view shows largest at
  the canvas aspect; ties go to the nearer aspect.

A **secondary** line whose parent is in another block can therefore end up with its parent in a lower row of blocks
than its child, pointing downward. The STUDIO-4 test at `__tests__/tree-layout.test.ts:113` pins that (#778's rule,
narrowed).

On the owner's model, `EmailThread` and `CommunicationParticipantRole` are **one-card trees**: no spine line reaches
them, but `Email` and `CommunicationParticipant` (both in the `Communication` tree) have secondary FKs onto them.
They wrap to row 2, under their children, so those lines point down.

## The decision (do not widen it)

1. **A one-card tree whose card is a parent of a card in another tree goes in the top row of blocks**, row 0. Call it
   a *lifted* block. "Parent of a card in another tree" means a secondary line whose parent end is that card and whose
   child end is in a different block. A one-card tree is a block of exactly one card.
2. **Order:**
   - Non-lifted blocks keep today's order: biggest first, then root id.
   - In row 0, the non-lifted blocks that fit come first, then the lifted blocks by root id.
   - On the owner's model at 16:10, row 0 reads `Communication`, `Person`, `CommunicationParticipantRole`,
     `EmailThread`, and every line points upward.
3. **Keep the largest-fit rule within that constraint.**
   - Every candidate packing must have all lifted blocks in row 0. So no candidate row width may be narrower than
     the lifted blocks side by side.
   - Among the candidates, choose as today: largest fit-to-view, ties to the nearer aspect.
   - The other blocks fill row 0 after the lifted ones are reserved, then later rows, greedily in their order.
4. **Multi-card cross-tree parents are unchanged.** A parent card inside a bigger tree still wraps wherever its block's
   size puts it. Keep #778's narrowed rule and the test at `:113` exactly as they are.
5. **Nothing inside a block moves.** The lift only changes which row a one-card block is in.

**The effect, stated plainly (put it in the code comment and in the docs):** deciding "lifted" reads secondary lines.
So adding or removing a cross-tree secondary line onto a one-card tree can move that one card between rows. No other
card moves, and nothing inside any block moves. The owner accepted this with (b). The two tests "adding or removing a
secondary line moves no card" (`:197`, STUDIO-3, and `:412`, STUDIO-4):
- If their fixtures don't involve a lift, they must pass **unchanged**.
- If one does involve a lift, do not loosen it: stop and report the exact case before editing it.

## Also (the owner's optional nit — only if trivial)

On a long entity name, the card's pattern badge clips: `CommunicationParticipantRole` shows `Ba` for `Base`. Fix it by
truncating the **name** with an ellipsis (`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space:
nowrap` on the name, `flex: none` on the badge), with the full name in a `title`. The card component may live in
`packages/graph-components` (outside your scope) rather than `tools/studio/src/graph/SchemaNode.tsx`. If the fix needs
a file outside `tools/studio/src/**`, don't do it; report where it would go.

## Tests (pin the decision)

In `tools/studio/src/__tests__/tree-layout.test.ts`, with generic fixture names of your own:
- **A cross-tree parent that is a one-card tree sits in row 0**, after the non-lifted blocks that share row 0, and its
  line points upward (its y < its child's y).
- Two lifted blocks are ordered by root id.
- A one-card tree that is **not** a cross-tree parent still wraps as today.
- A **multi-card** cross-tree parent still wraps by size (the existing `:113` test, unchanged).
- Removing the cross-tree secondary line returns the one-card tree to where it wraps without the lift, and no other
  card moves.
- A packing test on the owner-shaped 8-card model: there is one at `:505`, "the 8-entity model's blocks". Check
  whether its fixture is the owner's shape. If its pinned values change, list each with old → new.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names
  or "dogfood" references into code, comments, tests, fixtures or docs; say "a host application". The entity names
  above (`Communication`, `EmailThread`, …) are the owner's private model: **never** use them in a fixture, test name,
  comment or doc. Use generic names of your own.
- **Scope:** `tools/studio/src/**`, plus the sentences that describe the packing in `CLAUDE.md` § Studio (the
  `packBlocks` paragraph) and `docs/specs/STUDIO-0.md`. Nothing else.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. List every pre-existing assertion you
  change with old → new and a one-line reason.
- Tokens only; no colour literals.
- **Stop and report instead of inventing** on any design question this brief does not answer. Two failed attempts at
  the same gate is also a stop.

## Exit — run all of this on your final tree, after your last edit

1. `just test-studio` → 0 (UI typecheck, unit ` 0 fail`, e2e). Report the new UI test total (it was 230).
2. `git diff -- tools/studio/src/__tests__ | grep -n '^-.*expect('` → only lines you list.
3. Colour-literal grep over the diff → no output (an issue reference like `#778` in a comment is fine; say so).
4. **Mutations**, each reverted, `git status --porcelain` back to what it was:
   - (a) Never lift → the row-0 test goes red.
   - (b) Lift multi-card trees too → a test goes red.
   - (c) Put lifted blocks first in row 0 → the order test goes red.
5. Don't take screenshots; the lead does. Do report the computed row-0 order and each card's row for an
   owner-shaped generic fixture at 16:10, and at 1404:1084 (≈ the canvas with the inspector hidden).

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short:
- Files changed.
- Each exit step → exit code → the line that decides it.
- The mutations' red lines.
- Every changed pre-existing assertion, with old → new.
- The badge: done, or where it would go.
- Anything you could not do.

Then stop and wait.
