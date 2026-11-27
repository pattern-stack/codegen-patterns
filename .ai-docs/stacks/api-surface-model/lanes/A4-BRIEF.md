# Lane brief — A4: Studio UI — the API tab

You are the **build lane for PR A4** of the API-surface plan. One PR's worth of work, nothing more.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-api-surface-a4`, branch
  `dugshub/api-surface-a4` (checked out; it sits on A3, which added `GET /api/surface` and `SurfaceResponse`).
  Run `mise trust && just install` first; `tools/studio` resolves its own deps (`just test-studio` installs them).
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1s4`. Report with `SendMessage` to that
  name. If it does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1s4`.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** Never put host-application names, paths, table names or "dogfood"
  references into code, comments, test names or fixtures. Use only the repo's own demo names.
- **The UI does not reshape the derivation.** `src/derived/**`, `src/__tests__/derived/**`,
  `test/api-surface-golden/**`, `src/studio/server/**` and `src/studio/shared/api.ts` are frozen for this PR. If the
  tab seems to need a field the surface does not carry, **stop and report** (PLAN §14.6: "the UI needs the
  derivation's shape changed after S1"). Also frozen: `templates/**`, `package.json`, `test/baseline/**`.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no deleted or loosened assertion, no deleted test file,
  no `@ts-ignore` / `@ts-expect-error` / `as any` / `as unknown as` in `tools/studio/src`.
- **Stop and report instead of inventing** on any design question PLAN §6.3 / STUDIO-2 do not answer. Two failed
  attempts at the same gate is also a stop.

## Read first

1. `CLAUDE.md` § Studio — especially the two single vocabulary tables (`relationship-kinds.ts`, `edge-kinds.ts`:
   "every surface renders *from* them rather than branching on a literal") and the theming rule ("never add a
   colour literal to a component"; `{ light, dark }` per row through `cssColor()`).
2. `docs/specs/STUDIO-2.md` (written in A3) §4 and §6, and `.ai-docs/stacks/api-surface-model/PLAN.md` **§6.3 and
   §14.2's A4 table**.
3. `src/derived/api/types.ts` — the shape you render (re-exported through `@studio-shared`). Read a real payload:
   `just studio-demo` then `bun src/cli/index.ts project surface --json` against `.studio-demo` (A2's verb).
4. `tools/studio/src/inspector/Inspector.tsx`, `YamlEditor.tsx`, `yaml-issues.ts` (the path→position walker
   behind `locateIssues`), `relationship-kinds.ts`, `graph/edge-kinds.ts`, `api/client.ts`, `App.tsx`,
   `ui/primitives`, `index.css` tokens.

## Deliverables (PLAN §9 row A4, §6.3)

| Piece | What |
|---|---|
| **API tab** | `InspectorTab` gains `'api'`, enabled for an entity node. New `inspector/ApiTab.tsx`. Sections: Repository, Service, Use cases, HTTP, Includes. Each row: name, param names, shape (`findByAccountId(id, opts) → many`), flags (unique, order, limit, read options), and an origin chip (`← relationships.account`, `← queries[1] (unique)`, `base`, `pattern Integrated`, `capability Actor`, `junction opportunity_contact`). A shadowed declaration shows under its row. Inherited (`emitted: false`) entries are shown as inherited, not mixed in with emitted ones. A service row with `delegatesTo` shows what it calls. A relationship / junction node shows its `unmodelled` reason ("not modelled yet (#679)") rather than an empty tab — an absent answer must never read as "no API". `http.enabled === false` reads as HTTP off, with `disabledBy` as its origin. |
| **Fetch + error state** | `api/client.ts` gains `surface()` → `GET /api/surface`. Fetched separately from the graph, refreshed when the project changes (where the graph reloads). A failed fetch shows an error state inside the tab; the canvas and the other tabs are unaffected. |
| **Provenance → YAML line** | Export the walker in `yaml-issues.ts` as `locatePath(source, path)`. `YamlEditor` gains a way to reveal a line (`revealLine`). Clicking a YAML origin chip (the winning one or a shadow) opens the YAML tab on the file the origin's `doc` names, at that path's line. |
| **One vocabulary table** | new `inspector/surface-kinds.ts`: per method kind and per origin kind — label, section, order. The tab renders from it and never branches on a kind literal in a component. REL-3 and #679 must become edits to this table. |
| **Colour** | existing tokens only. A relation-origin chip reuses the edge-kind colour (`edgeColor(edgeStyle(kind))` / `cssColor()`). No colour literal in `ApiTab.tsx` or `surface-kinds.ts`. |
| **Tests** | `tools/studio/src/__tests__/surface-view.test.ts` — the pure logic: rows built from a surface (sections, order, inherited split), chip text for every origin kind, the shadow display, the `unmodelled` and HTTP-off states, `locatePath` on a real demo YAML (`relationships.account` and `queries.0` land on the right lines). Use a real `project surface --json` payload of the demo as the fixture, not a hand-written one. |

## Exit — run all of this on your final tree, after your last edit

1. `just typecheck` → 0. `just test-unit` → 0, ` 0 fail`.
2. `cd tools/studio && bun run typecheck` → 0 (no CI gate typechecks the UI; this one is yours to run).
3. `just test-studio` → 0; ` 0 fail` in the UI unit run; `surface-view.test.ts` present and running.
4. `git diff --stat dugshub/api-surface-a3 -- src/derived src/__tests__/derived test/api-surface-golden src/studio templates package.json test/baseline` → empty.
5. `grep -rnE "['\"]#[0-9a-fA-F]{3,8}['\"]|rgba?\(|hsla?\(" tools/studio/src/inspector/ApiTab.tsx tools/studio/src/inspector/surface-kinds.ts` → no output.
6. `grep -rnE "'(fk_finder|finder|relation_one|relation_many)'" tools/studio/src --include='*.tsx'` → no output.
7. **Prove the tests can fail on their subject:** change one label or order in `surface-kinds.ts`, run the UI tests,
   see `surface-view.test.ts` fail naming it, revert, `git status --porcelain` back to what it was. Report the red line.
8. Run the app once against `.studio-demo` (`just studio`) and click through: the `contact` API tab, the
   `findByAccountId` row's shadow, an origin chip → YAML line, a relationship node, and the tab with the server
   stopped. Report what you saw (the lead captures the S2 screenshots; don't commit any).

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutation's red line; what the click-through showed;
anything built differently from PLAN §6.3 / STUDIO-2 §4 and why (the lead corrects them). Then stop and wait.
