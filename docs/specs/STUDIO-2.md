# STUDIO-2 — the API view: what each entity and each relationship generates

**Status:** In progress — the server route and contract are built (A3); the API tab (A4) and the edge view (A5)
are designed here and not yet built
**Date:** 2026-11-14
**Depends on:** STUDIO-0 (#698), ADR-046 (`docs/adrs/ADR-046-derived-once-templates-print.md`)
**Coupled to:** #679 (collapsing `pattern: Junction` and `relationship:` into one concept), REL-3 (#588), STUDIO-1
(#717)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Studio ·
plan `.ai-docs/stacks/api-surface-model/PLAN.md` §6

Sections 1–3 and 8's e2e stage describe what is built. Sections 4–7 describe the design; A4 and A5 correct them to
what is built.

---

## 1. What it must make possible

> Select `contact` → every repository method, service method, use case and route it generates, each with the YAML
> line that caused it. Select the `contact → account` edge → what that one relationship generates on both sides.

Today Studio shows the model (entities, edges) and the YAML. What the generator *emits* from them — the method names,
which declaration won when two resolve to the same name, which routes exist — is visible only by reading generated
files. This spec puts it in the window, from the generator's own derivation.

---

## 2. Architecture

```
src/derived/api/                  the derivation (ADR-046) — the generator's, not Studio's
        │
codegen project surface --json    prints { command, entities, surface: ProjectApiSurface }
        │
src/studio/server/surface.ts      GET /api/surface — shells the verb through cli-runner.ts
        │
src/studio/shared/api.ts          SurfaceResponse — the derivation's types, re-exported
        │
tools/studio/**                   the API tab and the edge panel (A4, A5)
```

### Why the server shells the CLI

The same reason as every other Studio generator route (STUDIO-0 §2): Studio never reimplements generation, and the
only process the server spawns is the CLI, through `runCliJson` in `src/studio/server/cli-runner.ts`.
`getSurface` copies `getGraph`'s pattern exactly — `runCliJson(['project', 'surface'], { cwd })`, and a missing
payload (or one without `surface`) throws `CliFailureError`, which the server returns as a 502. It never returns
`{}`: a failed derivation must not render as an entity that generates nothing.

In-process was rejected for a second reason specific to this route: patterns and capabilities are registered in a
process-global registry filled by dynamic imports. A long-lived server process would keep serving a `.pattern.ts`
from before an edit. A fresh CLI process per call cannot.

### Why its own route

`/api/surface` is registered beside `/api/graph` (`src/studio/server/index.ts`), not folded into it. The surface can
fail where the graph does not — an invalid `api.includes` allowlist is a generation error, as is an app pattern that
fails to load — and that failure must not blank the canvas. The UI fetches the two independently; a surface error
shows in the API tab, and the graph still draws.

---

## 3. Contract

`src/studio/shared/api.ts`, types only:

```ts
export type {
	EntityApiSurface, Origin, ProjectApiSurface, RelationApiSurface, YamlRef,
} from '../../derived/api/types.js';
export interface SurfaceResponse { surface: ProjectApiSurface }
```

The types are **re-exports, never mirrored** — the hand-copied `SerializedDomainGraph` in the old viewer is the drift
this rule exists to stop. The import is `import type`, so the UI bundle never pulls the derivation into the browser
(`grep -nE '^import ' src/studio/shared/api.ts | grep -v 'import type'` is empty).

`SurfaceResponse` carries the CLI's `surface` only. The envelope's `entities` count is not repeated: it is
`Object.keys(surface.entities).length`.

What the payload holds, per ADR-046 and `src/derived/api/types.ts`:

- `entities[name]` — `repository`, `service`, `useCases`, `http` (routes, include keys, the compiled allowlist).
  Every method has an `origin`: `base`, `pattern`, `capability`, or `yaml` with the `YamlRef` that won and the
  `shadows` that resolved to the same name and lost.
- `relations[]` — one per REL-1 edge, keyed by REL-1's own origin string (`contact.relationships.account`), with
  `inverseOf`, the methods it `generates` on either side, and its `includeKeys`.
- `unmodelled[]` — junction- and `relationship:`-owned modules the derivation does not yet describe (deferred to
  #679), each with a reason.
- `warnings[]` — a delegate that calls a method its target does not emit (F7 / D4 in the plan).

---

## 4. The API tab (built in A4)

`InspectorTab` gains `'api'`. Its button is disabled when nothing is selected; once open, it stays open when another
node is selected (as `relate` does). The tab is `inspector/ApiTab.tsx`; the pure view model it renders is
`inspector/surface-view.ts`.

- **Sections**, in order: Repository, Service, Use cases, HTTP, Includes. Each header counts its rows; Repository and
  Service read `6 + 11 inherited`.
- **Row order**: by the kind order in `surface-kinds.ts`, stable, so rows of one kind keep the derivation's order —
  the FK finder sorts before the `queries:` finders.
- **Row anatomy**: name, parameter names, shape — `findByAccountId(id, opts) → many` — then flags (`unique`, `order`,
  `limit`, read options). A service row with a delegate shows what it calls. No TypeScript types: the derivation
  carries none until slice 2.
- **Inherited** (`emitted: false`) entries sit in a collapsed group per source ("Inherited from pattern Integrated —
  11"), never mixed with emitted rows.
- **Origin chip**: `← relationships.account`, `← queries[1]`, `base`, `pattern Integrated`, `capability Actor`,
  `junction opportunity_contact`. Uniqueness is a row flag, not chip text: a chip appends a `YamlRef.note` only when
  the derivation sets one. A relation-sourced chip takes its edge kind's colour (`edge-kinds.ts`), so the chip and
  the line it explains match.
- **Shadowing**: a declaration that lost to another of the same name is shown under the winning row with its own
  chip — the demo's `contact` shows "shadows ← queries[0] — resolved to the same name and lost" under
  `findByAccountId`.
- **Provenance → line**: clicking any YAML chip, winning or shadowed, opens the YAML tab on the file its `doc` names
  and reveals that declaration's line (`relationships.account` → line 43, `queries[0]` → line 49 in the demo). The
  walker behind Zod issue mapping is exported as `locatePath(source, path)`; when the path was edited away it returns
  the nearest ancestor with `exact: false` and the YAML tab says so; when nothing matches it returns `undefined`.
  `YamlEditor` gains `revealLine`. The inspector re-syncs the open file to the selection only when the selection
  changes, so a chip that opens another file (a junction's) is not undone.
- **HTTP off**: `http.enabled === false` reads as HTTP off, with `disabledBy` as its chip.
- **Includes**: one row per compiled path — route · path, depth, max depth, the allowlist constant. An empty
  allowlist reads "No `api.includes` declared — `?include=` is closed." (charter I6).
- **Unmodelled**: a relationship or junction node shows "<name> — not modelled yet (#679)" and the CLI's reason. A
  node in neither `entities` nor `unmodelled` says it is undescribed; no state ever shows an empty list.
- **Failure**: a failed `/api/surface` shows the error and a Retry in the tab; the canvas and other tabs are
  unaffected. An error outranks "Nothing selected", so a dead server is never hidden behind an empty selection. When
  the whole server is down, a header Reload also empties the canvas (the graph route fails too); the canvas stays
  intact when the surface route fails on its own.
- **Tests**: `tools/studio/src/__tests__/surface-view.test.ts` over three real `project surface --json` payloads of
  the demo (`__tests__/fixtures/`, regenerated per its README) — no hand-written surface. The demo has no capability
  or junction origin, so those two chips are tested with typed `Origin` values.

---

## 5. The edge view (design — built in A5)

- **Edge selection.** Selection becomes `{ kind: 'node' | 'edge'; id }`; the canvas gains `onEdgeClick` and dims for
  an edge.
- **`relationId`.** Each drawn edge carries `relationId` = `<from>.relationships.<name>`, set where the edge id is
  built (`adapters/schema-adapter.ts`) and never parsed back out of the id.
- **Panel.** `relations[relationId].generates` by side, then those of its `inverseOf`, then `includeKeys`.
- **Junctions.** Junction-origin methods appear on both parents' API tabs. Whether a `pattern: Junction` pairing is
  itself a selectable edge is open (§10).

---

## 6. Vocabulary table (built in A4)

`tools/studio/src/inspector/surface-kinds.ts` — one row per method kind and per origin kind: label, section, order.
The API tab and the edge panel render from it and never branch on a kind literal, as `relationship-kinds.ts` and
`edge-kinds.ts` already work. #679 and REL-3 become edits to this table, not conditionals across components. It also
holds each section's label, order and empty-state sentence, and each origin kind's chip; it reads the derivation's
unions off `@studio-shared` rather than restating them, and holds no colour.

---

## 7. Theming

Existing colour tokens only (`tools/studio/src/index.css`). A relation-origin chip reuses the edge-kind colour
(`edgeColor(edgeStyle(kind))` in `graph/edge-kinds.ts`). No colour literal in a component.

---

## 8. Gates

**The e2e stage (built, `just test-studio`).** `test/studio/run-studio-e2e.ts` boots the real server against the
real demo project and asserts over HTTP, by exact value:

| Stage | Expectation |
|---|---|
| 2b `GET /api/surface` | entities are exactly `account`, `contact`, `opportunity` |
| | `contact` emits exactly `count findByAccountId findByEmail findById findByIds list` |
| | `findByAccountId`'s origin is `relationships.account` and it shadows exactly `queries.0` |
| | `findByEmail` is `queries.1`, `unique: true`, returns `one` |
| | `contact`'s routes are exactly `GET /contacts`, `GET /contacts/:id`, `POST /contacts`, `PATCH /contacts/:id`, `DELETE /contacts/:id` |
| | `contact.relationships.account`'s `inverseOf` is `account.relationships.contacts`; it generates exactly `contact.repository.findByAccountId` and `contact.service.account` |
| | `AccountService.contacts` is `relation_many`, delegating to `contact.findByAccountId` |
| | `warnings` and `unmodelled` are both `[]` |
| 9b, after the relationship YAML is written | `unmodelled`'s `{ name, kind }` are exactly `[{ name: 'contact_opportunity', kind: 'relationship' }]` |

The stage was mutation-checked: changing the expected shadow path to another value turns `just test-studio` red,
naming that expectation.

**UI unit tests (A4, A5).** Pure-logic tests of the view model the tab and edge panel render from, in
`tools/studio/src/__tests__/`.

**Not proven.** No test renders the tab or the panel — nothing in CI renders any Studio pane (STUDIO-0 §6.3). A
person looks at it at sign-off.

---

## 9. Not in this spec

- A reachability view (which entities a path can reach).
- Executing a path against data (STUDIO-1 / REL-3).
- A Columns tab, and TypeScript types on rows (slice 2 of the derivation).

---

## 10. Open questions

- Should a `pattern: Junction` pairing be a selectable edge? Not in v1; revisit with #679.
- Does a shadowed declaration deserve a warning in the YAML editor, not only a line in the API tab?
- A link from a row to the generated file in the diff drawer.

---

## 11. Charter invariants

| | How this holds it |
|---|---|
| I1 declare once | Studio displays the generator's derivation, fetched from the CLI. It derives nothing and mirrors no type. |
| I6 HTTP closed by default | The tab displays the compiled include allowlist; nothing in Studio widens it. |
| I9 gates are honest | The e2e asserts exact values and was shown to fail on a changed expectation; what is not proven is stated (§8). |
| I10 public repository | Only the demo project's names appear here and in the gate. |
