# Frontend Pipeline Rebuild — pts / frontend-patterns Architecture

**Status:** implemented (FE-1..FE-4 merged; the stack is complete)
**Date:** 2026-06-04
**ADR:** ADR-038
**Reference design:** `pattern-stack/pattern-stack` → `tools/cli/src/pts/codegen/` (generator + `SPEC-unified-entity-store.md`, 1,871 lines incl. verified TanStack DB API reference) and `pattern-stack/frontend-patterns` → `src/sync/` (`createEntityHooks.ts`, `createStore.ts`, `EntityStoreProvider.tsx`)

## Goal

Replace the 26-template hygen frontend pipeline with a TypeScript emitter that renders the complete frontend tree — per-entity wiring AND cross-entity files — from the full entity set, with all hook/mutation logic consumed from `@pattern-stack/frontend-patterns` instead of hand-rolled into generated files.

Success = a fresh `project init` + `entity new` × N + `bun run typecheck` in the consumer frontend passes with zero manual file creation, and re-running generation is idempotent (no prompts, no dropped collections, no inject errors).

## Target output tree

All paths via `locations.*` (defaults shown):

```
apps/frontend/src/generated/          # locations.frontendGenerated
├── index.ts                          # whole-set barrel
├── config.ts                         # per-entity sync modes + runtime overrides (pts config.ts.j2)
├── query-client.ts                   # shared QueryClient (pts query_client.ts.j2)
├── api/
│   ├── client.ts                     # base fetch client: baseURL + auth header fn
│   ├── <entity>.ts                   # per-entity REST methods → generated NestJS controllers
│   └── index.ts
├── collections/
│   ├── <entity>.ts                   # createCollection wiring, branched on entity sync mode
│   └── index.ts
├── entities/
│   ├── <entity>.ts                   # createEntityHooks({collection, api, schema types}) wiring
│   └── index.ts
├── store/
│   └── index.ts                      # createStore({entities, collections}) over full set
└── fields/
    ├── <entity>.ts                   # field metadata (ported from fields.ejs.t, shape unchanged)
    └── index.ts
```

Entity types/Zod schemas continue to come from `locations.dbEntities` (`packages/db`) — not re-emitted here.

Every file is a **complete-file write** with the `@generated` banner. No inject ops, no anchors, no `skip_if`/`force` frontmatter semantics.

## What dies (delete in the PR that replaces it — no deprecation shims)

| Deleted | Replaced by |
|---|---|
| `templates/entity/new/frontend/**` (all 26) | `src/emitters/frontend/` |
| All 11 `_inject-*` anchor templates + `_ensure-anchor-collections` | whole-set emission |
| Inline hooks/mutations/mutation-hooks/error-tracking in `combined.ejs.t`, `entity/hooks|mutations|mutation-hooks.ejs.t`, `store/hooks.ejs.t` | `createEntityHooks` (factory) |
| `unified-entity.ejs.t` + phantom `./create-unified-entity` import | `entities/<entity>.ts` wiring |
| trpc `onInsert/onUpdate/onDelete` handlers in collection templates | generated REST api client fed to the factory |
| `pipelines:` config block + `PipelinesConfigSchema` + `getPipelinesConfig` (validated, never consumed) | `generate.frontend` is the single gate |
| Knobs that mimic hand-rolled shapes: `generate.structure`, `hookStyle`, `hookReturnStyle`, `collectionNaming`, `fileNaming`, `typeNaming`, `collectionsIndex`, `fkResolution`, `frontend.collections.schemaPrefix` | factory shape is the shape; direct named schema imports |
| Naive inline pluralizers in templates (entity/collection.ejs.t:131, combined.ejs.t:75,233) | registry-resolved target naming |

## What survives

- `generate.frontend` boolean gate (default false; scanner detection unchanged)
- `frontend.auth.function` (+ null-disables convention), `frontend.parsers`, `frontend.sync.shapeUrl/useTableParam/columnMapper/columnMapperNeedsCall/apiBaseUrlImport/apiUrl` — consumed by the emitter
- `frontend.sync.mode` — becomes the **global default**; per-entity `sync:` overrides
- `generate.fieldMetadata` toggle; field-meta emission shape (`FieldMeta`, `<entity>Fields`, `<entity>Metadata`) unchanged
- `locations.frontend*` path/import pairs

## New

1. **Per-entity sync mode** — entity YAML gains `sync: api | electric` *inside the `entity:` block* (sibling to `surface:`/`context:`, under the strict `EntityConfigSchema`), read as `entity.sync` — not a top-level key (refined during FE-1 implementation). Absent → global `frontend.sync.mode`, default `electric`. `offline` (Electric + Dexie) is **deferred** — schema rejects it with a pointer to this spec.
2. **Cross-entity registry naming** — the emitter loads ALL `entities/*.yaml` (existing parser) and resolves FK target names (file name, plural, class, collection var) from the **target's own YAML**. Mirrors pts `_resolve_relationship_targets`. No plural is ever derived from a string at emit time.
3. **REST api client** — `api/<entity>.ts` emits `list/get/create/update/delete` (+ declarative-queries finders, follow-on) against the generated NestJS controller routes, returning `{ txid }` passthrough where the backend provides it. `api/client.ts` carries baseURL resolution (`apiBaseUrlImport` | `apiUrl`) and the auth-header function.
4. **Whole-set step** — `entity new` post-step and `gen-all` both end with `emitFrontendSet(allEntities)`; output is deterministic for a given entity set (safe under the baseline runner's wipe-and-regenerate).

## Version pairing (contract)

The emitter emits imports against, and the consumer must install:

| Package | Range |
|---|---|
| `@pattern-stack/frontend-patterns` | `^0.2.0-alpha.18` (alpha dist-tag) |
| `@tanstack/react-db` | `^0.1.55` |
| `@tanstack/electric-db-collection` | `^0.2.11` |
| `@tanstack/query-db-collection` | `^1.0.6` |
| `@tanstack/react-query` | `^5.x` |

Pinned as a constant in `src/emitters/frontend/deps.ts`; emitted into a comment block in `generated/index.ts` so drift is visible in the consumer. (Doctor-style package.json validation: open question.)

## Implementation steps (stacked, PR-sized)

**FE-1 — schema + naming groundwork** (src-only, no emission change)
- `entity-definition.schema.ts`: add `sync: z.enum(['api','electric'])` optional *inside `EntityConfigSchema`* (the `entity:` block, sibling to `surface:`/`context:`), read as `entity.sync` — NOT a top-level key.
- Expose a cross-entity registry from the parser: `{ name → { plural, className, fileBase } }` for all sibling YAMLs (extend the existing `targetExists` machinery in prompt.js/parser).
- `GenerateConfigSchema`: enumerate surviving frontend knobs; drop `.passthrough()` for the frontend keys; delete `pipelines-config.schema.ts` pipelines block + `config-loader` validation + `getPipelinesConfig`.
- Update `test/fixtures/codegen.config.yaml` (remove dead `pipelines:` block).

**FE-2 — emitter: collections + api + base files**
- New `src/emitters/frontend/` (NOT under `src/cli/` — sets the target home per the standing emitter-relocation intent): `emit-collections.ts`, `emit-api.ts`, `emit-base.ts` (query-client, config), `deps.ts`, `index.ts` (`emitFrontendSet`).
- Collection wiring branches per entity sync mode (port pts `collection.ts.j2` electric/api branches; carry over `shapeUrl/useTableParam/columnMapper/parsers/auth` emission from current templates).
- Delete `templates/entity/new/frontend/collections/**`.
- Emission unit tests (string-level, like `frontend-sync-mode.test.ts` but against the emitter).

  *Implementation notes (FE-2, done):*
  - **Entity type import is plain `<Class>`.** The dead `typeNaming` knob's two
    branches imported `<Class>` (`'plain'`) vs `<Class>Entity` (default). No
    template in *this* repo emits `packages/db/src/entities/<name>.ts` — the
    `dbEntities` location (`@repo/db/entities`) is an external assumption — so the
    actual export name is unobservable from here. Per the spec's "prefer plain if
    both" instruction, the emitter imports `import type { <Class> } from
    '<dbEntities>/<name>'`. **FE-4 must verify** the consumer's `@repo/db/entities`
    actually exports plain class names; if it only exports `<Class>Entity`, this is
    the single knob to flip in `emit-api.ts` / `emit-collections.ts`.
  - **api-mode collections delegate transport to the api client** (`<camel>Api.list()`
    from `../api/<name>`), not an inline fetch — the deleted template inlined a
    fetch; the new split keeps transport in one place.
  - **SSR guard** is uniform: `typeof window !== 'undefined' ? window.location.origin : ''`
    feeds every `new URL(...)` in the electric branch (the templates applied it
    inconsistently).
  - **`config.ts` deferral comment** says "the offline mode" (no quoted `'offline'`
    literal) so a strict "no 'offline' as a mode value" test can coexist with the
    OQ-6 pointer.

**FE-3 — emitter: entities + store + fields + barrels**
- `emit-entities.ts` (createEntityHooks wiring incl. per-entity hook re-exports), `emit-store.ts` (createStore + resolvers from relationships), `emit-fields.ts` (port fields.ejs.t), `emit-index.ts`.
- Delete the rest of `templates/entity/new/frontend/**`; remove frontend branches from `prompt.js` context that no longer have readers (`frontend.*` knobs move to emitter config loading).
- Emission unit tests incl. a two-entity FK fixture asserting registry-resolved names (irregular plural case: `person`/`people`).

  *Implementation notes (FE-3, done):*
  - **Context gained `parsed: Map<string, ParsedEntity>`.** The registry stays the
    only NAMING source; `parsed` (keyed by entity name) supplies fields,
    relationships, behaviors, and `expose`. Resolver/lookup/field-row emission
    considers only `belongs_to` relationships whose target is in the registry
    (old `existingBelongsTo`).
  - **`expose` added to the parser.** `ParsedEntity` did not carry `expose`; the
    schema defaults it to `['repository','rest','trpc']`. Added `expose` to
    `ParsedEntity` + `transformToEntity` so the fields emitter can gate write
    capabilities. **Capabilities rule:** `create/update/delete =
    expose.includes('repository') || expose.includes('trpc')` (the
    `exposeRepository || exposeTrpc` of the old template); `list`/`get` always
    true (read is never gated).
  - **Adaptation 1 — single type param.** `createEntityHooks<<Class>>(…)`. The
    published factory (`frontend-patterns@0.2.0-alpha.18`) defaults
    `TCreate`/`TUpdate` to `Partial<TEntity>`; the pts `<Class>Create`/`Update`
    schema types are unverifiable in our `dbEntities` consumers, so we don't
    import them.
  - **Adaptation 2 — `name:`/`getSyncMode` keyed by SINGULAR entity name** (not
    table). pts keyed `name:` by table; our FE-2 `config.ts` table is keyed by
    `entity.name`, so the runtime `getSyncMode` lookup must use the same key.
  - **Adaptation 3 — store keyed by PLURAL, not table.** `entity.table` is
    independent of `entity.plural`; the registry's plural is the stable
    cross-entity name family, so `entities:`/`collections:`/lookups are keyed by
    plural (`store.<plural>.useList()`). Recorded as a divergence from pts
    `store.ts.j2`'s `table_name` keying.
  - **resolvers/lookups are self-contained (package-verification finding).** The
    published `frontend-patterns` exports ONLY `createStore` (which builds
    `store.resolve`/`store.lookups` internally) + `createEntityHooks` — it does
    NOT export `createResolvers`/`buildLookups`/`createLookups`/`EntityLookup`,
    which the pts `resolvers.ts.j2`/`lookups.ts.j2`/`store_index.ts.j2` imported.
    Those templates predate the consolidation. The emitter therefore emits
    `store/resolvers.ts` + `store/lookups.ts` as fully self-contained modules
    with the same semantics (FK resolve = `collection.state.get(fkValue)`,
    typed `<Class>Refs` hydration) and imports nothing from the package beyond
    `createStore`. `store/module-index.ts` re-exports them and is what the root
    `index.ts` imports (mirrors pts `index.ts.j2`'s `./store/module-index.js`).
  - **Self-referential FK** (target === self) imports its collection + type
    exactly once: every type import is per-entity from the registry set and FK
    targets are always in that same set, so there's no second import. Tested.
  - **`field-meta.ts` UI derivation** is ported from `prompt.js`
    (`inferUiType`/`inferUiImportance`/`formatLabel`, the entity_ref skip, the
    choices/FK handling). The per-field `format` (old `ui_format`) is DROPPED —
    the parser does not carry `ui_format` onto `ParsedField`, so it's
    unobservable; only the hardcoded timestamp `format: { dateFormat: 'relative' }`
    survives.
  - **Orphan locations removed.** `emit-fields.ts` emits a self-contained
    `fields/field-meta.ts` TYPE file, so `locations.frontendFieldMetaTypes` was
    deleted (zero readers after template deletion).
  - **prompt.js pruning (grep-before-delete, all had zero readers outside
    prompt.js):** removed `frontendEnabled`, the four frontend-store naming
    consts (`singularCamelName`/`pluralCamelName`/`collectionVarName`/
    `collectionVarNamePlural`), the `frontend:` locals block +
    `frontendConfig`/`frontendSync` consts, and the 12 frontend `generate.*`
    members (`fieldMetadata`/`collections`/`collectionsIndex`/`hooks`/`mutations`/
    `hookStyle`/`structure`/`typeNaming`/`fkResolution`/`collectionNaming`/
    `fileNaming`/`hookReturnStyle`). KEPT: `electricWhere*` (read by
    `backend/presentation/controller.ejs.t`), all backend `generate.*` members.

**FE-4 — CLI wiring + docs + coverage**
- `entity new` post-step + `gen-all` call `emitFrontendSet`; `project init` adds the version-pairing deps to the consumer frontend package.json when `generate.frontend: true`.
- README: full `frontend:`/`generate.frontend`/per-entity `sync:` reference section.
- Baseline: add a frontend-enabled fixture + checked-in `test/baseline/` frontend snapshots (closes the zero-coverage gap).
- Smoke (optional, follow-on): typecheck emitted frontend against installed deps in the tmp project.

  *Implementation notes (FE-4, done):*
  - **Schema renamed `pipelines-config.schema.ts` → `codegen-config.schema.ts`.**
    The FE-1 filename was a misnomer — nothing pipelines-shaped survives.
    Mechanical path update across the three importers (`config-loader.ts`,
    `runtime-import.ts` comment, `schema-v2.test.ts`); grep for
    `pipelines-config.schema` is clean. Added `FrontendConfigSchema`
    (+ `FrontendAuthConfigSchema` / `FrontendSyncConfigSchema`) there, wired into
    `config-loader` always-parse (defaults applied even when the block is
    absent), and `ProjectConfig.frontend` typed. `.strict()` on the frontend
    block — the deleted mimicry knobs are now config errors, not passthrough.
  - **auth null-disables via Zod `.default()` semantics.** `auth.function`
    absent → `'getAuthorizationHeader'`; explicit `null` → disabled. Zod
    `.default()` only fires on `undefined`, so an explicit `null` survives
    untouched — no separate sentinel needed (preserves the old `hasOwnProperty`
    convention exactly).
  - **`load-context.ts` is the single CLI seam.** `loadFrontendEmitContext(cwd,
    config, opts)` loads the registry + parsed map, maps the validated config +
    `generate.architecture` + `locations.*` into `FrontendEmitConfig`, and
    returns `{ skip: undefined, ctx, outDir }` or `{ skip: reason }` (zero
    entities). **Locations are read off the in-hand config** (with the
    `locations.mjs` defaults inlined) rather than importing that module's
    `LOCATIONS` singleton — the singleton binds `process.cwd()` at import time,
    which is wrong under the CLI's `--cwd`. `mapFrontendEmitConfig` re-parses the
    raw `frontend` value through the schema so defaults apply uniformly for both
    the loaded-config (CLI) and partial-object (test) callers.
  - **Post-step placement + contract.** The frontend emission block sits in
    `entity.ts` after the orchestration post-step, gated on
    `generate.frontend === true`, try-wrapped non-fatal but NOT silent (emitted
    count + outDir print; skips + failures print). Runs ONCE after the `--all`
    loop — it's whole-set, never per entity. Surfaced in both the JSON payload
    (`frontend: { outDir, written, fileCount }`) and the human summary.
  - **init merge = `mergeFrontendDeps`.** Mirrors the `mergeTsconfig`
    idempotent-merge precedent: when `generate.frontend: true`, locate the
    frontend `package.json` from `paths.frontend_src`'s parent (default
    `apps/frontend/`); if present, ADD only missing `FRONTEND_EMITTED_DEPS` keys
    (existing version ranges preserved verbatim, re-run never duplicates/
    reorders); if absent, emit a `skip` plan-entry NOTICE listing the deps to
    install verbatim. Never fails init. `@pattern-stack/codegen`'s own
    package.json is untouched.
  - **Coverage = golden-tree test, NOT baseline-runner integration (FALLBACK
    path taken — reasoning recorded).** The baseline runner (`test/run-test.ts`)
    drives `bunx hygen entity new` per entity and bolts post-step artifacts on
    via one-off `bun -e` shims; the frontend emitter is a whole-set TS function
    with no hygen surface, and the baseline `tsconfig.baseline.json` aliases
    (`@shared/*`) don't resolve `@repo/db/entities` or
    `@pattern-stack/frontend-patterns`, so it could never compile the emitted
    frontend (the snapshot would be content-only anyway). Integrating it would
    also subject the snapshot to the runner's `bun run lint` biome reformat pass
    (a non-determinism vector). So coverage is a dedicated golden-tree test
    (`src/__tests__/emitters/frontend/golden-tree.test.ts`) wired into
    `just test-unit`: it runs the REAL CLI path (`loadFrontendEmitContext` →
    `emitFrontendSet`) into a tmp dir and compares byte-for-byte against
    `test/frontend-golden/snapshot/`. The fixture set
    (`test/frontend-golden/entities/`: explicit-plural `person` + FK-consumer
    `user`) LOCKS registry-resolved naming — `user belongs_to person` references
    `persons` (person.plural) in the store/resolvers, and per-entity sync
    (`user: api`, `person: electric`) is asserted. Snapshot regenerated twice;
    byte-identical both times. `load-context.test.ts` covers the config mapping
    (defaults, null-disables, overrides, architecture, locations) + the skip.
  - **dbEntities plain-`<Class>` contract VERIFIED-as-documented (FE-2 open
    item).** The emitter imports `import type { <Class> } from
    '<dbEntities>/<name>'`. This repo emits no `packages/db/src/entities/*.ts`,
    so the export name stays a consumer contract — documented in the README
    "Frontend generation" section as the dbEntities requirement (export the
    plain `<Class>`, not `<Class>Entity`). No emitter change needed; the single
    knob (in `emit-api.ts` / `emit-collections.ts`) is flagged if a consumer's
    db package only exports `<Class>Entity`.

---

### Revision — 2026-06-06: `frontend.fields.textareaThreshold` (configurable textarea cutoff)

The `500` constant hardcoded in `inferUiType`'s `string` branch is now
configurable as `frontend.fields.textareaThreshold` (default `500`; explicit
`null` disables the heuristic entirely). This adds the `frontend.fields` config
home the spec anticipated for future inference knobs.

- **Schema:** `FrontendFieldsConfigSchema` (`.strict()`, `.default({})`) with
  `textareaThreshold: z.number().int().positive().nullable().default(500)`,
  registered in `FrontendConfigSchema` as `fields:`.
- **Emit config:** `FrontendEmitConfig.textareaThreshold: number | null` (required
  field; `mapFrontendEmitConfig` supplies it from `fe.fields.textareaThreshold`).
- **Pure-function API:** `InferenceOptions { textareaThreshold?: number | null }`
  + `DEFAULT_TEXTAREA_THRESHOLD = 500` exported from `field-meta.ts` (and
  re-exported from `index.ts`). `inferUiType(field, opts)` and `deriveFieldMeta(field,
  defaults, opts)` both accept it; the `string` branch uses strict `>`.
- **Threading:** `displayFields(parsed, opts)` in `emit-fields.ts` passes
  `{ textareaThreshold: ctx.config.textareaThreshold }` down from
  `buildEntityFieldsFile`.
- **Semantics:** absent/`undefined` → 500 (byte-identical baseline output);
  explicit number → custom cutoff (strict `>`); explicit `null` → all bounded
  strings stay `text` unless the author sets `ui_type: textarea`.
- **Tests:** new suites in `emit-fields.test.ts` (pure `inferUiType` cases +
  `deriveFieldMeta` threading + `buildEntityFieldsFile` ctx→displayFields proof)
  and `load-context.test.ts` (absent/null/custom via `mapFrontendEmitConfig`).
- **Docs:** README `frontend:` block updated with `fields.textareaThreshold`
  example + null-disables paragraph. Baseline output unchanged (default 500).

## Open questions

1. **Doctor check** — should the emitter (or `dev-check`) validate the consumer's installed versions against `deps.ts`? Lean yes, follow-on PR.
2. **Electric shape scoping** — `electricWhereColumn/Value` (computed in prompt.js, currently unused) + soft-delete `deleted_at IS NULL` belong in emitted `shapeOptions` `where`/params. In scope for FE-2 or follow-on? (Resolves the long-standing TODO comment the old templates emitted.)
3. **Declarative queries → api client finders** — `queries:` block could emit typed finder methods on the api client. Follow-on.
4. **`EntityStoreProvider` mounting** — consumer must mount the provider; document in README (FE-4) or scaffold an `app-setup.example.tsx`?
5. **frontend-patterns `sync/` split** — heavy hard-deps (radix, mapbox, router, axios) make a lean `@pattern-stack/entity-store` attractive once there are external consumers. Tracked in that repo, not here.
6. **`offline` sync mode** — deferred until a consumer needs Dexie persistence; pts `dexie-bridge.ts.j2` is the reference when it lands.

## Appendix — 2026-06-04 review findings → resolution map

| Finding | Resolution |
|---|---|
| First-run inject-before-add drops first collection (Critical 1a) | whole-set complete-file emission (FE-2) |
| Re-run `Overwrite?` prompt can wipe collections.ts (1b) | same — no add-vs-exists semantics remain |
| 11 inject ops target files nothing creates; phantom imports (1c) | base files emitted (FE-2/FE-3); factory imported from published package |
| Pluralization 3-way divergence (H-2) | registry-resolved naming (FE-1/FE-3) |
| `fileNaming: plural` honored by half the templates (H-3) | knob deleted; one canonical file naming |
| `api` mode missing from entity/collection.ejs.t (H-4) | single collection emitter, per-entity mode branch (FE-2) |
| Duplicate collections per entity under default config (H-5) | one collection per entity, one stack (FE-2/FE-3) |
| Dead `pipelines:` block (M-6) | deleted (FE-1) |
| Unvalidated passthrough knobs (M-7) | enumerated in Zod; mimicry knobs deleted (FE-1) |
| ~1/26 template test coverage; baseline excludes frontend (M-8) | emitter unit tests + frontend baseline fixture (FE-2..4) |
| combined.ejs.t duplication/drift (M-9) | template deleted; single emitter path |
| txid handlers in queryCollectionOptions (M-10) | trpc handlers deleted; REST client + factory own mutations |
| `./query-client` assumed sibling (M-12) | emitted `generated/query-client.ts` |
| README gap (M-13) | FE-4 |
