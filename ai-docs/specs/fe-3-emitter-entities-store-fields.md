# FE-3: Frontend Emitter — Entities + Store + Fields + Barrels

**Parent:** docs/specs/2026-06-04-frontend-pipeline-rebuild.md (FE-3) · ADR-038
**Branch:** `fe-3/emitter-entities-store-fields` off `fe-2/emitter-collections-api-base`
**Status:** approved (parent spec gated; e2e run authorized)
**Reference templates (READ FIRST):** `/tmp/pattern-stack-ref/tools/cli/src/pts/codegen/frontend/templates/` — `entity.ts.j2`, `entities_index.ts.j2`, `store.ts.j2`, `store_index.ts.j2`, `resolvers.ts.j2`, `lookups.ts.j2`, `index.ts.j2`. (If /tmp clone is missing: `git clone --depth 1 --filter=blob:none --sparse https://github.com/pattern-stack/pattern-stack.git /tmp/pattern-stack-ref && cd /tmp/pattern-stack-ref && git sparse-checkout set tools/cli/src/pts/codegen`.)

## Overview

Second half of the emitter: per-entity `createEntityHooks` wiring, whole-set `createStore`, FK resolvers/lookups, field metadata, and the root barrel. Then delete ALL remaining `templates/entity/new/frontend/**` and prune the now-readerless frontend context from `prompt.js`. Still library + tests only (CLI wiring = FE-4).

## Context extension

`FrontendEmitContext` gains the data fields/relationships need:

```ts
export interface FrontendEmitContext {
  entities: EntityRegistryEntry[];
  parsed: Map<string, ParsedEntity>;   // NEW — keyed by entity name; fields + relationships source
  config: FrontendEmitConfig;
}
```

Registry stays the ONLY naming source; `parsed` supplies fields/relationships. Resolver/lookup emission considers only belongs_to relationships whose target exists in the registry (the old `existingBelongsTo` semantics).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/emitters/frontend/types.ts` | modify | add `parsed` |
| `src/emitters/frontend/emit-entities.ts` | create | `entities/<name>.ts` + `entities/index.ts` |
| `src/emitters/frontend/emit-store.ts` | create | `store/index.ts`, `store/resolvers.ts`, `store/lookups.ts`, `store/module-index.ts` (match pts root-index expectations — see index.ts.j2) |
| `src/emitters/frontend/field-meta.ts` | create | UI-metadata derivation ported from prompt.js (label/type/importance/sortable/filterable/choices/foreignKey) |
| `src/emitters/frontend/emit-fields.ts` | create | `fields/field-meta.ts` (the TYPE file — self-contained, kills the `locations.frontendFieldMetaTypes` orphan), `fields/<name>.ts`, `fields/index.ts` |
| `src/emitters/frontend/emit-index.ts` | create | root `index.ts` barrel incl. version-pairing comment from `deps.ts` |
| `src/emitters/frontend/index.ts` | modify | `emitFrontendSet` = full tree |
| `templates/entity/new/frontend/**` (everything remaining) | **delete** | entity/, store/, generated/, unified-entity.ejs.t, root `_inject-entities-*` |
| `templates/entity/new/prompt.js` | modify | prune readerless frontend context (see Pruning rules) |
| `src/__tests__/emitters/frontend/emit-{entities,store,fields,index}.test.ts` | create | see Tests |
| `docs/specs/2026-06-04-frontend-pipeline-rebuild.md` | modify | implementation notes (living docs) |

## Emission shapes (port from pts, adapt where noted)

**`entities/<name>.ts`** (from `entity.ts.j2`):
- `createEntityHooks` from `@pattern-stack/frontend-patterns`; collection from `../collections/<name>`; api from `../api/<name>`; `getSyncMode` from `../config`; type from dbEntities (plain `<Class>`, per FE-2 decision).
- **Adaptation 1:** call `createEntityHooks<<Class>>(…)` with ONE type param — `TCreate`/`TUpdate` default to `Partial<TEntity>` in the factory signature; the pts `<Class>Create`/`<Class>Update` schema types are unverifiable in our consumers. Record in parent spec.
- **Adaptation 2:** `name:` + the `getSyncMode('…')` key MUST match FE-2's `config.ts` key (read `emit-base.ts` and stay consistent — singular entity name).
- **Adaptation 3:** no state-machine block (we have none).
- `localFirst: () => getSyncMode('<name>') !== 'api'`.
- Destructured per-entity re-exports exactly like pts: `useList → use<ClassPlural>… ` follow `entity.ts.j2`'s naming (`use<Class>List`, `use<Class>`, `useCreate<Class>`, `useUpdate<Class>`, `useDelete<Class>`, `<camel>Keys`).
- `entities/index.ts` from `entities_index.ts.j2` (minus state-machine lines).

**`store/`** (from `store.ts.j2` / `store_index.ts.j2` / `resolvers.ts.j2` / `lookups.ts.j2`):
- `store/index.ts`: `createStore` from `@pattern-stack/frontend-patterns`; `entities:` and `collections:` keyed by **plural** (NOT table — table can diverge; record as adaptation), `export type AppStore`.
- `resolvers.ts` / `lookups.ts`: port the pts templates. If they reference frontend-patterns exports that don't exist in `0.2.0-alpha.18` (verify: `npm view @pattern-stack/frontend-patterns@alpha` or read the GitHub source under `src/sync/`), simplify to self-contained code with the same semantics (FK resolve = `collection.state.get(fkValue)`) and record the divergence.
- `store/module-index.ts` only if pts's root `index.ts.j2` expects it (`./store/module-index.js`) — mirror whatever keeps the root barrel coherent, adapting paths to our tree.

**`fields/`** (port of the old `fields.ejs.t` shape — unchanged output contract):
- `fields/field-meta.ts`: emit the `FieldMeta<T>` / `FieldType` / `FieldImportance` types, self-contained (interface = exactly the properties the metadata objects use: field/label/type/importance/sortable?/filterable?/format?/choices?/reference?).
- `fields/<name>.ts`: `<camel>Fields` + `<camel>Metadata` — same shape as the deleted template (primaryFields/searchFields/defaultSort/capabilities). `capabilities.create|update|delete`: the old template used `exposeRepository || exposeTrpc`; adapt to `expose` from the parsed entity (`repository`-inclusive default) — record the exact rule you implement.
- UI derivation (`field-meta.ts` helper): port from `prompt.js` the bits the old template consumed — `ui_label` (humanized name or explicit `ui.label`), `ui_type` mapping, `ui_importance` heuristic (name/title → primary…), `ui_sortable`/`ui_filterable`, `hasChoices`/`choices`, FK `reference` (foreign_key table). Unit-test the derivation directly. Skip entity-ref internal fields exactly as the old template did (`isEntityRefType`/`isEntityRefId` equivalents).
- Timestamps: `hasTimestamps` from behaviors (`timestamps` in entity behaviors list) → createdAt/updatedAt rows + defaultSort, as before.

**Root `index.ts`** (from `index.ts.j2`): section comments + `export *` of collections/api/entities/fields + store + config (+ query-client export). Prepend the version-pairing block: render `FRONTEND_EMITTED_DEPS` as a comment table. Watch collisions: if `export *` of two barrels would collide (it shouldn't — distinct name families), prefer explicit re-exports for the colliding module and note it.

## prompt.js pruning rules

After template deletion, remove ONLY context with zero remaining readers. Method: for each candidate (`frontend:` block, `frontendEnabled`, `collectionVarName`, `collectionVarNamePlural`, the frontend members of `generate:` — `fieldMetadata`, `collections`, `collectionsIndex`, `hooks`, `mutations`, `hookStyle`, `structure`, `typeNaming`, `fkResolution`, `collectionNaming`, `fileNaming`, `hookReturnStyle`), grep `templates/` for the identifier; delete iff no hits. Known keeper: `electricWhere*` (read by `backend/presentation/controller.ejs.t`). `singularCamelName`/`pluralCamelName`: check before touching. Backend `generate.*` members stay untouched.

## Tests

- entities: wiring file contains factory import, single type param, localFirst closure, all 6 re-exports; index sorted.
- store: keys are plurals; FK resolver — **two-entity fixture with `person` (plural: `people`) referenced by `task.assignee_id`** asserting resolver/lookup names come from the registry (`peopleCollection`/`people` keys, NOT `persons`); self-referential FK (target === self) doesn't self-import.
- fields: derivation unit tests (label humanization, importance heuristic, choices, FK reference, timestamps rows); metadata shape snapshot for one entity.
- index: deps comment present; deterministic byte-identical re-emission (whole `emitFrontendSet` on a 2-entity ctx, run twice, compare).
- Whole-set: `emitFrontendSet` writes the full tree into a tmp dir; assert file inventory matches the parent spec's target tree.

## Gates

`just test-unit` 0 fail · `just test-baseline` pass · `bun run typecheck` no NEW errors (3 known pre-existing) · after template deletion, `grep -rn "frontendEnabled\|locations.frontend" templates/` returns only files outside entity/new/frontend (expected: none for frontendEnabled).

## Constraints

- No CLI wiring. No changes under `src/cli/**`.
- Emitted code imports `@pattern-stack/frontend-patterns` — do NOT add it to this repo's package.json (it's a consumer-side dep; emission tests are string-level).
- Conventional commit, Co-Authored-By trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do not push.
