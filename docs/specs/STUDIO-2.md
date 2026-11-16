# STUDIO-2 — the API view: what each entity and each relationship generates

**Status:** Built (Phase A) — the server route and contract (A3), the API tab (A4) and the edge view (A5)
**Date:** 2026-11-14
**Depends on:** STUDIO-0 (#698), ADR-046 (`docs/adrs/ADR-046-derived-once-templates-print.md`)
**Coupled to:** #679 (collapsing `pattern: Junction` and `relationship:` into one concept), REL-3 (#588), STUDIO-1
(#717)
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Studio ·
plan `.ai-docs/stacks/api-surface-model/PLAN.md` §6

Every section describes what is built; §10 holds what is still open.

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

**The failure carries the CLI's words (A5, Doug's S2/E2).** Every failure of `project surface --json` prints
`{ command: 'project surface', status: 'error', error }` and exits 1 — the #669 convention `entity new` follows —
instead of an empty stdout (`printError` is a no-op in JSON mode, so before A5 neither stream said anything).
`getSurface` passes `error` through as the 502's `detail` when `status === 'error'` and `error` is a non-empty string;
otherwise it keeps the stderr/stdout fallback, and a missing payload is still a failure. So an `api.includes` path
that names no relation reaches the API tab as `project surface failed` over
`account.api.includes.find_by_id: 'nonexistent' names no relation at 'nonexistent' — …`, not as the JSON envelope and
not as "the server is not responding". Unit-tested in `src/__tests__/cli/project-surface-json-errors.test.ts`.
`project graph --json` still has the empty-stdout flaw on its one failure path (no entity directory); not fixed here.

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
  the line it explains match. The chip sits beside the signature when both fit; otherwise it drops onto its own line
  under it, and it is never wider than that line: a longer chip ends in an ellipsis, with its full text in the
  tooltip. The signature never shrinks to make room, and wraps only between words (`surface-row-layout.test.tsx`).
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
- **Failure**: a failed `/api/surface` shows the error and a Retry in the tab — for a 502, the server's `error` as the
  title and the CLI's message (§2) as the detail; only an unreachable server (status 0) reads as "not responding"
  (`api/describe-error.ts`); the canvas and other tabs are
  unaffected. An error outranks "Nothing selected", so a dead server is never hidden behind an empty selection. When
  the whole server is down, a header Reload also empties the canvas (the graph route fails too); the canvas stays
  intact when the surface route fails on its own.
- **Tests**: `tools/studio/src/__tests__/surface-view.test.ts` over three real `project surface --json` payloads of
  the demo (`__tests__/fixtures/`, regenerated per its README) — no hand-written surface. The demo has no capability
  or junction origin, so those two chips are tested with typed `Origin` values.

---

## 5. The edge view (built in A5)

- **Edge selection.** Selection is `{ kind: 'node' | 'edge'; id } | null` (`graph/selection.ts`), held by `App.tsx`.
  The canvas has `onEdgeClick`; a second click on the selected node or edge clears it (`toggleSelection`). Node
  selection lights what it did before (the library's `useGraphSelection`). Edge selection is computed in Studio
  (`edgeHighlight`): the edge and its two endpoints stay lit, everything else dims. The selected edge draws one step
  wider.
- **One line per foreign key (A6, #778).** A `belongs_to` and its inverse `has_many` / `has_one` are drawn as one
  line, paired on the foreign key (holder + column + referenced entity), labelled `account ⇄ contacts`
  (`pairedLabel`, `graph/edge-kinds.ts`). The line carries the `belongs_to`'s `relationId` and the inverse's as
  `inverseRelationId`; selecting it opens the panel on the `belongs_to`, whose **inverse** group is the other side.
  An unpaired `has_many` is its own line with its own `relationId`.
- **Spine or secondary (STUDIO-3).** Every line is one or the other (`treeRole`), and the panel's first line prints
  why, exactly as the adapter wrote it on the line (`treeReason`): `spine: inherits` for a child's `inherits:`, or
  `secondary: chart's spine is catalog (first declared)`. The line's tooltip prints the same string. Selection is
  unchanged by the role: a secondary line selects its relation and shows both sides like any other.
- **Where the panel shows.** Selecting an edge opens the inspector's API tab, which renders `inspector/EdgePanel.tsx`
  in place of the entity surface. The API tab is enabled for a node or an edge; Detail stays node-only. The tab's
  failure and loading states apply to the edge panel unchanged — an error still outranks the selection.
- **`relationId`.** `StudioEdgeData.relationId` is set where the edge is built (`relationIdOf` in
  `adapters/schema-adapter.ts`) from the edge's own fields: `<from>.relationships.<name>`, or `<from>.roles.<role>`
  for a role-derived edge — the derivation's spelling for both — and `<child>.inherits` for an `inherits:` line (#875:
  read off the serialized entity's `inherits.relationId`, which the derivation's `inheritsRelationId` spells; the line is
  one relation of kind `inherits`, child → base, not half of a pair). Nothing parses an edge id. A junction's two halves
  carry none. `schema-adapter.test.ts` pins every demo edge's `relationId` / `inverseRelationId` and asserts the set of
  both equals the ids in a real `project surface --json` payload of the same graph.
- **Panel** (`inspector/edge-view.ts`, pure). A heading chip — the relation's id, in its edge kind's colour, linked to
  its declaration (read off the provenance of a method it generates on the declaring entity, never rebuilt from the
  id). Then four groups, in `EDGE_GROUPS` order (`surface-kinds.ts`):
  1. **on `<from>`** — `generates` entries on the declaring entity;
  2. **on `<to>`** — `generates` entries on the other entity (in the demo, always empty: a `belongs_to` generates on
     its own side, its `has_many` inverse on the other);
  3. **inverse** — the `inverseOf` relation's chip and its `generates`;
  4. **Include keys** — the relation's `includeKeys`, then its inverse's.
  Each method row is the entity surface's own entry (`surface-rows.tsx`, shared with the API tab): signature, kind
  label, `→ entity.layer.method`, origin chip. A `generates` entry its entity does not list is flagged
  `not on the entity surface`, not dropped. Each group states its empty sentence rather than showing nothing.
- **Never an empty list.** A junction half reads "No relation surface for this edge" (its methods are on both
  parents' API tabs); an inline edge whose `relationId` the surface does not list reads "`<id>` is not in the derived
  surface". Both sentences live in `EDGE_PANEL_STATES`.
- **Junctions.** Junction-origin methods appear on both parents' API tabs. A `pattern: Junction` pairing is not a
  selectable relation in v1 (§10).
- **Tests**: `__tests__/edge-view.test.ts` over the demo payload (`contact → account`, `account → contacts`, a
  junction half, an unlisted relation, no inverse, a missing method); `__tests__/selection.test.ts`.

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
| 7b, `api.includes.find_by_id.paths: [nonexistent]` appended to `entities/account.yaml` through `PUT /api/files` | `GET /api/surface` is 502, `error` is `project surface failed`, `detail` contains `account.api.includes.find_by_id: 'nonexistent' names no relation at 'nonexistent'` and is not the JSON envelope; `GET /api/graph` still answers 200 with 4 edges; after the file is restored, the surface's entities are exactly the three again |
| 9b, after the relationship YAML is written | `unmodelled`'s `{ name, kind }` are exactly `[{ name: 'contact_opportunity', kind: 'relationship' }]` |

The stage was mutation-checked: changing the expected shadow path to another value turns `just test-studio` red,
naming that expectation.

**UI typecheck (A5, Doug's S2/E3).** `just test-studio` runs `bun run typecheck` in `tools/studio` before the unit
tests, so a type error in a component fails CI.

**UI unit tests (A4, A5).** Tests of the view models the tab and edge panel render from, in
`tools/studio/src/__tests__/`. One renders: `surface-error.test.tsx` drives a 502 through the real client, the error
description and `ApiTab` (`react-dom/server`), and asserts the markup carries the CLI's message and not "not
responding".

**Not proven.** Nothing renders the canvas or the edge panel, and no browser runs in CI. A person looks at them at
sign-off.

---

## 9. Not in this spec

- A reachability view (which entities a path can reach).
- Executing a path against data (STUDIO-1 / REL-3).
- A Columns tab, and TypeScript types on rows (slice 2 of the derivation).

---

## 10. Open questions

- Should a `pattern: Junction` pairing be a selectable relation? Not in v1: its two halves are selectable edges and
  say they have no relation surface. Revisit with #679.
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
