# Lane brief — A5: Studio — methods on an edge, plus two things Doug asked for at S2

You are the **build lane for PR A5**, the last PR of Phase A. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a5`, branch
  `dugshub/api-surface-a5` (checked out; it sits on A4 = the API tab). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names, fixtures or specs. Use only the repo's own demo names.
- **Frozen:** `src/derived/**`, `src/__tests__/derived/**`, `test/api-surface-golden/**`,
  `src/__tests__/templates/no-name-derivation*`, `templates/**`, `package.json`, `test/baseline/**`,
  `test/junction/__snapshots__/**`, every other golden, `test/run-test.ts`, `test/smoke/_consumer-errors.ts`. The
  derivation's shape was signed off at S1: if the edge view needs a field the surface does not carry, **stop and
  report** (PLAN §14.6). `src/studio/server/**` and `src/studio/shared/api.ts` too — if the CLI-error case below
  needs a server change, stop and report what and why first.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no deleted or loosened assertion, no deleted test file,
  no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as` in `tools/studio/src` or `src/studio`.
- **Stop and report instead of inventing** on any design question PLAN §6.3 / STUDIO-2 §5 do not answer. Two failed
  attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` § Studio (the canvas counts — a first-class relationship is a node plus two edges; the vocabulary
   tables; theming) and § Testing.
2. `docs/specs/STUDIO-2.md` §4 (the API tab as built in A4), **§5 (the edge view — your design)**, §6.
3. `.ai-docs/stacks/api-surface-model/PLAN.md` **§6.3 (the edge rows), §14.2's A5 table**.
4. `tools/studio/src/App.tsx`, `graph/SchemaCanvas.tsx`, `adapters/schema-adapter.ts`, `graph/edge-kinds.ts`,
   `inspector/surface-kinds.ts`, `inspector/surface-view.ts`, `inspector/ApiTab.tsx`, and their tests.

## Deliverables

| # | What |
|---|---|
| 1 | **Edge selection.** Selection becomes `{ kind: 'node' \| 'edge'; id }`; the canvas gains `onEdgeClick`; dimming for a selected edge is computed in Studio (its two endpoints stay lit). Node selection keeps working exactly as today. |
| 2 | **`relationId` on each drawn edge** = `<from>.relationships.<name>`, set where the edge id is built (`adapters/schema-adapter.ts`), and never parsed back out of the id (`grep -rn "\.id\.split(" tools/studio/src` must print nothing). Edges with no relation surface (a junction's two halves) carry none and say so in the panel. |
| 3 | **`inspector/EdgePanel.tsx`** — for a selected edge: `relations[relationId].generates` grouped by side (the declaring entity's methods, then the other entity's), then its `inverseOf`'s, then `includeKeys`. Rows and labels come from `surface-kinds.ts` (extend that table; do not branch on kind literals in a component). Tokens only; a relation chip takes its edge kind's colour. A selected edge with no surface entry reads as not modelled / not described — never an empty list. |
| 4 | **Doug, S2/E2:** the real failure case. With the server up, `codegen project surface` itself fails (an invalid include allowlist is a generation error). The API tab must show **the CLI's error text**, not "the Studio server is not responding". Add a test for it: (a) a Studio e2e stage that makes the demo's surface fail for real — e.g. write an `api.includes` path that does not exist into a demo entity through the server's own file route, `GET /api/surface` → the server's failure status with the CLI's message in the body — then restores the file and asserts the surface is back; and (b) a UI unit test that this response renders the CLI's text in the tab. Prove both can fail (mutation). The lead captures the screenshot. |
| 5 | **Doug, S2/E3:** `just test-studio` also runs `cd tools/studio && bun run typecheck`, so the UI is typechecked in CI. A gate addition — put it before the unit tests in the recipe. |
| 6 | **Docs:** `docs/specs/STUDIO-2.md` §5 to what you built (and §4/§8 for item 4 and the new gate); status from *In progress* to *Built (Phase A)*. Leave `PLAN.md` to the lead — list the differences in your report. |

## Exit — run all of this on your final tree, after your last edit

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `just test-studio` → 0 — now including the UI typecheck; ` 0 fail` in the UI unit run; the e2e prints the new
   failure stage as passing.
3. `schema-adapter.test.ts` still asserts **4 nodes · 6 edges** for the demo graph with a relationship.
4. `grep -n "relationId" tools/studio/src/adapters/schema-adapter.ts` → ≥ 1 line; `grep -rn "\.id\.split(" tools/studio/src` → no output.
5. `grep -rnE "['\"]#[0-9a-fA-F]{3,8}['\"]|rgba?\(|hsla?\(" tools/studio/src/inspector/EdgePanel.tsx tools/studio/src/inspector/surface-kinds.ts` → no output;
   `grep -rnE "'(fk_finder|finder|relation_one|relation_many)'" tools/studio/src --include='*.tsx'` → no output.
6. `git diff --stat dugshub/api-surface-a4 -- src/derived src/__tests__/derived test/api-surface-golden src/studio templates package.json test/baseline test/junction/__snapshots__ test/relations-golden test/frontend-golden test/frontend-graph-golden test/semantic-golden test/integration-emit test/smoke/_consumer-errors.ts test/run-test.ts` → empty.
7. Mutations, each reverted with `git status --porcelain` back to what it was: (a) the edge panel's ordering or
   label in `surface-kinds.ts` → its unit test fails naming it; (b) the e2e failure stage's expected CLI text → the
   e2e fails naming it; (c) the UI's CLI-error rendering (e.g. fall back to the generic message) → the unit test
   fails. Report each red line.
8. Run the app once against a demo (`just studio <dir> <port> <vite_port>` — pick free ports; another session may
   hold 5178/5179) and click: the `contact → account` edge, the `account → contacts` edge, a junction-half edge, and
   the tab with `project surface` failing for real. Report what you saw; don't commit screenshots.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; each mutation's red line; what the click-through
showed; anything built differently from PLAN §6.3 / STUDIO-2 §5 and why. Then stop and wait.
