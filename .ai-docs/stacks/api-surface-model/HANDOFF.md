# api-surface-model: orchestrator handoff (2026-11-16)

## State

| What | PR | State |
|---|---|---|
| Phase B (ADR-046), stack B1–B5 | #888, #895–#899 | merged |
| STUDIO-4: tree blocks wrap, the inspector hides and goes full screen, one-card trees dock | #900 | merged |
| Release 0.34.0 | #928 | merged, published |
| Studio API tab: a long origin chip no longer squeezes the signature | #929 | merged (b82f37db) |
| STUDIO-5: dbt-style selectors, double-click to focus | #933 | rebased onto b82f37db; certified; the lead merges on green CI |
| STUDIO-6: a spine-order toggle, and a floating-inheritance prototype | #934 | rebased onto main after #933; the lead merges on green CI |

## Open

- **Slice 2, first piece: Studio's FK rows.** Approved and not started. The plan is in
  [`SLICE2-FK-ROWS.md`](SLICE2-FK-ROWS.md): a two-PR stack, the derivation in `src/derived/columns/` served in
  `/api/graph` first, then the UI. Update #892 along the way.
- **The floating-inheritance prototype (#934)** is exploratory. If the owner drops it, the delete path is in #934's
  body: `graph/FloatingBase.tsx`, plus the lines that name `FLOAT_INHERITANCE` in `SchemaCanvas.tsx`,
  `SchemaNode.tsx`, `GraphPane.tsx` and `App.tsx`, the last `describe` of `spine-order.test.ts`, and one paragraph each
  in STUDIO-0 and CLAUDE.md.
- `packages/graph-components/__tests__/hooks.test.ts` restates the text filter as a test copy, and runs in no CI gate.
  Either point it at `matchesGraphQuery` or put the library's tests in a gate. Low priority.

## Decisions recorded

- **A junction is crossed both ways (STUDIO-5 D2, the owner's call).** A first-class relationship node is one hop
  between its ends, in either direction, and is shown. As a result, an up-walk picks up an ancestor's many-to-many
  partners (`+opportunity` on the demo includes contact).
- **A comma is a union (STUDIO-5).** Whitespace and commas both separate tokens: `a+, b+` is `a+ b+`. This diverges
  from dbt, where a comma is an intersection; Studio has no intersection. A comma is never part of a token. A box
  holding only commas is no tokens, the same as an empty box: everything shown, no message.
- **One owner for the text match (STUDIO-5).** `packages/graph-components` exports `matchesGraphQuery`. Its
  `useGraphFilter` hook applies it, and so does the selector for each text token. `__tests__/graph-query.test.tsx`
  holds both to it.
- **The API tab's origin chip (#929).**
  - The row wraps.
  - The signature keeps `min-width: min(100%, 20ch)` and breaks only between words.
  - A long chip drops under the signature, is bounded by the panel, is cut off with an ellipsis, and has its full text
    in a tooltip.
  - The real-browser check is not in CI: the e2e harness is HTTP-only. The unit test pins the CSS.
- **The spine order (STUDIO-6).**
  - Inheritance first (the default) is `inherits` > `on_delete: cascade` > first declared. Ownership first is cascade
    > `inherits` > first declared.
  - The unique-FK tier is gone (#875).
  - One ranking table, `SPINE_ORDERS`, lives in `graph/spine.ts`.
  - The choice is remembered under `studio.spineOrder`.
- **Floated `inherits` lines (STUDIO-6 prototype).**
  - They are hidden at rest, and drawn while the child, the base or the line is selected.
  - They stay secondary, so no card moves.
  - The chip sits 24 px above the card, so card sizes do not change.

## How this stack was run

- Lanes were started in Herdr (`hc run --bg --no-notify --name <lane> --cwd <worktree> claude …`) with a brief in
  `lanes/`. Lanes leave work uncommitted.
- The orchestrator reviews the diff and scans it for host-application names. It commits, then runs `just test-all` in
  a Herdr watch terminal, one at a time, because concurrent runs race the `bunx` cache (#885). Then it opens the PR with
  `gh stack init --base main <branch>` and `gh stack submit --auto --open`, and posts a CI comment on green.
- Screenshots: point the browser at the server port of `just studio <dir> <port> <vite>`, never the Vite port (Vite's
  `/api` proxies to 5178), and check `/api/health` `projectDir` first.
- Take Studio asks only from the lead session. Route a request that arrives from any other session to the lead.
