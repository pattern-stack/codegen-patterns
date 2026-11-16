# Lane brief — STUDIO-4 (part 3): dock one-card trees under the card that references them

You are a **build lane for one change** on the STUDIO-4 PR (#900, open, unmerged). The owner looked at the layout on
2026-11-15 and asked for this as a rule. Do this change and nothing else.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-4-tree-blocks`, branch
  `dugshub/studio-4-tree-blocks` @ `510f068b` (on `main` @ `cd03f8f3`). Work on top of it, uncommitted.
  - **Do not touch** the hc terminal `studio-900` or ports 5977/5978. That is the owner's running Studio.
  - For your own app runs use ports 6177/6178, and point the browser at the **server** port 6177, never the Vite port.
    Vite's `/api` proxy goes to 5178, which is another session's server.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage`; if that doesn't
  resolve, use `ListAgents` and look for a name starting `dugshub-api-surface-a0-`.

## Why

`tools/studio/src/layout/tree-layout.ts` lays each tree out as a block and `packBlocks` wraps the blocks into rows.
Largest-fit chooses the wrap, and it depends on the canvas width. On the owner's model, two one-card trees are each
the target of a secondary line from a card in a bigger tree. With the inspector open they happen to wrap directly
under their referencing cards, which is what the owner wants. With it hidden, the wider repack moves them elsewhere.
That placement must become a rule, independent of width.

## The rule (do not widen it)

1. **Dock.** Take a one-card tree (a block of exactly one card) whose card is the parent end of a secondary line from a
   card *C* in another block *B*. It is not wrapped by `packBlocks`. Instead it becomes part of *B*:
   - It sits **directly below *C***: x-centred on *C*.
   - Its top is at *B*'s current bottom (its lowest card) plus the normal row spacing. That is the row below *B*'s
     rows.
   - *B*'s footprint (its width and height for packing) includes it.
   - The docked card's position relative to *B* is fixed, so it's identical at every canvas width.
2. **One referencer.** If cards in several blocks reference it, dock it under the **first by declaration order** (the
   order the secondary edges arrive in). State in a comment which order that is.
3. **No chains, no cycles.** Dock only under a card of a block that is **not** itself a docked one-card tree. A
   one-card tree referenced only by other one-card trees wraps as today.
4. **Two docked cards under one block** whose x-centred spots would overlap: keep their order (by their referencer's
   x) and push them apart horizontally just enough to clear, by the normal sibling spacing. Never overlap a card.
5. **Multi-card cross-tree parents are unchanged.** That's #778's narrowing: a parent in a bigger tree wraps by its
   block's size and may sit below its child.
6. **The effect, stated plainly** (in the code comment, in `CLAUDE.md` § Studio where it describes the packing and
   `packBlocks`, and in `docs/specs/STUDIO-0.md`):
   - Docking is the **one place a secondary line places a card**. Adding or removing such a line docks or undocks
     that one card.
   - No other card moves within its block. The referencing block's footprint grows, so the packing may change.
   - The two existing "adding or removing a secondary line moves no card" tests (`__tests__/tree-layout.test.ts`
     `:197` and `:412`): if their fixtures don't involve a one-card target, they must pass **unchanged**. If one
     does, stop and report before editing it.

## Tests (pin it)

In `tools/studio/src/__tests__/tree-layout.test.ts`, with generic fixture names of your own:

- A docked card sits directly below its referencer: x-centred, and its top at the referencing block's bottom plus row
  spacing. Check this at **three target aspects** matching the owner's canvas at 1440×900: inspector open (≈ 1016 ×
  canvas height), inspector hidden (≈ 1404 × h) and full screen (≈ 1404 × the taller h, with the drawer hidden). Its
  offset from the referencer is identical at all three.
- An owner-shaped fixture: a 4-card tree with three children, and two one-card trees each referenced by a different
  child. Both dock, each under its own referencer, at all three aspects.
- First-by-declaration-order wins when two blocks reference the same one-card tree.
- A one-card tree referenced only by another one-card tree is not docked (no chains).
- A one-card tree with no lines onto it still wraps as today.
- A multi-card cross-tree parent still wraps by size (#778, unchanged).
- The `atlas` test (`:113`): `atlas` is a one-card tree referenced by `chart`, so it now docks under `chart`.
  - Re-pin it to the docked position, and rename the test to say what it pins.
  - List old → new: it was `{ x: 0, y: 424 }`.
  - If it no longer covers the multi-card case, add a separate test for that case.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names
  or "dogfood" references in code, comments, tests, fixtures or docs; say "a host application". The owner's entity
  names must never appear in any file in the repo.
- **Scope:** `tools/studio/src/**`, plus the packing sentences in `CLAUDE.md` § Studio and `docs/specs/STUDIO-0.md`.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. List every pre-existing assertion you
  change, with old → new.
- Tokens only. **Stop and report** on any design question this brief doesn't answer.

## Exit (on your final tree)

1. `just test-studio` → 0. Report the UI test total; it was 230.
2. `git diff -- tools/studio/src/__tests__ | grep -n '^-.*expect('` → only lines you list.
3. Mutations, each reverted:
   - (a) drop docking → red;
   - (b) dock multi-card trees too → red;
   - (c) ignore declaration order → red.
4. **Acceptance script.** Write `accept-dock.mjs` in **your scratchpad**, not the repo, because it names the owner's
   entities. It uses Playwright, like the lead's `/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-api-surface-a0/e4d7824a-677e-46d0-8d28-c17dcb28583a/scratchpad/s3/pw/capture-s7.mjs`;
   reuse its node_modules by running from that folder.
   - Input: a base URL. Window 1440×900.
   - For each of **inspector open** (drawer hidden), **inspector hidden** (drawer hidden) and **full screen**, print:
     - the fit zoom;
     - for each pair, EmailThread under Email and CommunicationParticipantRole under CommunicationParticipant: the
       on-screen x-centre difference in px, and whether the docked card's top is below the referencer's bottom.
   - Run it against your own Studio on the owner's model copy,
     `/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-api-surface-a0/e4d7824a-677e-46d0-8d28-c17dcb28583a/scratchpad/s5/model`,
     with `just studio <that dir> 6177 6178`. Report the output.
   - Acceptance: x-centre difference ≤ 1 px and below, in all three states; zoom ≥ 0.73 open and ≥ 0.80 hidden.
   - Stop your server afterwards.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short:
- Files changed.
- Each exit step → exit code → the deciding line.
- The mutations' red lines.
- Every changed assertion, old → new.
- The acceptance script's path and its output.
- Anything you could not do.

Then stop and wait.
