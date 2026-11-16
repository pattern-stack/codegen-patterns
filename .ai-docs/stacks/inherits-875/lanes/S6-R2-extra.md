# S6 — extra work for phase R2 (from the S6 phase R light review)

Do these on top of ADAPT2.md's steps, on the rebased S6. **DECIDED** items are coordinator decisions.

1. **A second `choices_of` resolver survived** — `src/studio/server/relationships.ts:159 baseKinds` (over raw YAML
   Documents; `choices: []` behaves differently). Replace it with `discriminatorKindsOf(baseDoc.toJSON(), [ownerDoc.toJSON()])`
   (or `enumChoices`); the parameter types are structural. Make the RFC's "S6's own copies are gone" true.
2. **DECIDED — the frontend reads the derived surface.** The emitter already builds REL-1's graph inputs
   (`buildClientGraph`, `graph-model.ts:218-235`), so `hasCreateRoute` (and every create/update/delete emission —
   hooks, api, `fields` capabilities) reads route/use-case existence from `deriveProjectApiSurface` once per emit,
   not `createDisabledBy` directly. This also closes the `generate.writes` gap the RFC records as "not fixed here"
   (an entity with writes off gets no create/update/delete mutation): close it, gate it in the frontend fixtures
   (an electric entity with `generate: { writes: false }`, `@ts-expect-error` on its mutations), and update the RFC.
   Correct the false reason text in `emit-utils.ts:21-23` and RFC `:1756` / `:1815`.
3. **DECIDED — Studio's inherits line is a real relation.** `relationSurfaces` (`src/derived/api/project.ts`) lists an
   `inherits` relation per child whose `generates` are the methods already carrying origin `<child>.inherits`;
   `buildEdges` sets `relationId` on the inherits line; the edge panel then shows `findWithBase` / `listFlat` / … with
   provenance instead of "one half of a junction pairing". Golden + Studio test.
4. **DECIDED — follow STUDIO-3's recorded plan:** #891 / `spine.ts` said that when #875 lands the unique-FK inference
   "is deleted, no shim". Delete tier 2 (unique FK), `fkUnique`, `fkColumnUnique` and their parity test; keep tier 1
   (`inherits`) and the remaining tiers. Update `spine.ts`'s doc, CLAUDE.md's Studio section and the RFC.
5. CLAUDE.md: the canvas counts differently from `/api/graph` in **three** ways now (an `inherits:` has no
   `graph.edges` entry but one spine line); fix the `buildEdges` docstring (`schema-adapter.ts:213,221`) likewise.
6. RFC "Decisions at a glance" (Upsert row) and CLAUDE.md:114: say it as built — an entity with its own `natural_key`
   gets `upsertByNaturalKey` → `{ row, created }`; a child gets it through its base's key → `{ row, created,
   baseCreated }`; a child of a keyless base gets none.
7. `issue-comments.md` #780: add "a child gets `upsertByNaturalKey` through its base's key; a child whose base declares
   none has no upsert."
8. Gate: a test where the `/api/relationships` inherits write is refused by `validateContent` itself (e.g. a child
   that declares its own `timestamps` — R5), so "validates like every Studio write" can fail.
