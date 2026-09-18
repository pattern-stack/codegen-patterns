# Plan — Drizzle 1.0 + relations graph + semantic model + pattern extension (units 1–5)

**Stack:** `relations-v2-and-semantic-model` · **Governed by:** `PROJECT.md` (the charter — goal, invariants, decisions, update protocol)
**Written:** 2026-09-16 against `main` @ `efe6afb` (v0.29.0) · **Revised:** 2026-09-17 after operator decisions
**Scope of this document:** the per-unit technical plan. Decisions and open questions live in `PROJECT.md` §7; this
file only says *how* each unit is expected to be built. Specs (`docs/specs/<KEY>.md`) supersede it per issue.

> **Tracker (synced 2026-09-17).** Project #578 → epics #579 (unit 1), #580 (units 2+5), #581 (unit 3), #582 (unit 4).
> DRZ-1 #583 · DRZ-2 #584 · TEN-1 #585 · REL-1 #586 · REL-2 #587 · REL-3 #588 · FE-REL #589 · SEM-1 #590 · SEM-2 #591 ·
> SEM-3 #592 · CAP-1 #593 · CAP-2 #594 · CAP-3 #595 · QS-1 = pattern-stack/query-surface#40. Source of the sync:
> `plan.yaml` (same directory). Board: https://github.com/orgs/pattern-stack/projects/3 (Status = the SDLC stage
> taxonomy; `sdlc.yml.project_number: 3`). All tasks start `state:planned`; specs are written per issue by `/design`.

Everything marked *verified* was checked this session against the working tree at `efe6afb`, the sibling
semantic-query package's checkout, or a scratchpad install of `drizzle-orm@1.0.0-rc.4` + `drizzle-kit@1.0.0-rc.4`
compiled with this repo's TypeScript 6.0.3.

---

## 1. Verified facts (corrections to the launch brief, since folded into `PROJECT.md`)

| Claim in the launch brief / upstream notes | What is actually true (verified) | Consequence |
|---|---|---|
| "zero `relations(` emission anywhere in `src`" | True for `src/`, **false for `templates/`**: v1 `relations()` consts are emitted by `templates/entity/new/backend/database/schema.ejs.t:234`, `templates/entity/new/clean-lite-ps/entity.ejs.t:87`, `templates/junction/new/entity.ejs.t:112`; gated in `prompt-extension.js:648-650`, `:1343`, `junction/new/prompt.js:116`. Locked by 6 baseline files + 2 junction snapshots. | Unit 1 cannot leave that slot untouched — 1.0 removes the API it uses. See §4.2. |
| "1.0 removes `relations()`" | `relations` is gone from the `drizzle-orm` root export (TS2724 on import); the v1 implementation survives only under the underscored legacy entry `drizzle-orm/_relations`. `defineRelations` is on the root export. | Emitted v1 consts fail to compile on 1.0. Do not import from `_relations`. |
| "`.array()` no longer chainable" | `text('x').array()` compiles on rc.4 (`pg-core/columns/common.d.ts:251`). | No template change for `string_array`. |
| "`.enableRLS()` → `withRLS()`" | `enableRLS` is deprecated, not removed. Repo uses neither. | Nothing to do. |
| "`getTableColumns()` → `getColumns()`" | Both exported; `getTableColumns` is marked "use `getColumns`". Used in **4** spec files, not 3 (`domain-events.schema.spec.ts` was missed). | Renamed in DRZ-2. |
| drizzle-kit migration format | Re-verified in DRZ-2 against the installed kit: `generate` writes `drizzle/<timestamp>_<name>/{migration.sql,snapshot.json}`; snapshot is `version: 8` (number, not the string `"8"`), `dialect: "postgres"`, keys `ddl / dialect / id / prevIds / renames / version`. No `meta/_journal.json`. | Generator emits no migrations, so no code change. Documented in **`docs/consumer/drizzle.md`** (new), linked from CONSUMER-SETUP. Consumer continuity is out of scope (charter §5). |
| Driver generics | `NodePgDatabase<TRelations extends AnyRelations = EmptyRelations>`; the pg config is `Omit<DrizzleConfig, 'schema'> & { codecs? }` — `schema` is **removed**, and `relations` is the slot. | Fixed in DRZ-2: the emitted `database.module.ts` is now `drizzle({ client: pool })` with `export type DrizzleDB = NodePgDatabase`, and no longer imports the schema barrel at all. `runtime/types/drizzle.ts` (`NodePgDatabase<any>`) still compiles; REL-1 replaces that `any` with the emitted manifest's type. |
| pg-proxy test harness | The `drizzle(async () => ({ rows: [] }))` callback shape is unchanged, **but the param/row mapping is not**: 1.0's pg codec system stopped serializing `jsonb` itself, so a `jsonb` bind param now reaches the callback as the raw JS object and a `jsonb` row value is passed through unparsed (`pg` does both conversions). | 4 runtime specs asserted 0.45's mapping and were corrected in DRZ-2 (DRZ-2 §A6). Any future spec that asserts captured params for a `jsonb` column must assert the object. |
| Sibling package coupling | `@pattern-stack/query-surface` is `private: true` (unpublished), peer-pins `drizzle-orm ^0.45.2`, and its Drizzle adapter (`registry/introspect.ts`, `registry/schema-registry.ts`) walks **v1** `Relations` objects. Its **model shape** (`AggregateModel`, `EntityDescriptor`, `AggRegistry`, `MeasureCatalog`) is plain data + `PgTable`/`PgColumn` refs and does not require introspection. | Unit 3 must emit a *declared* model, never one recovered by walking `relations()`. Whether that package itself runs on 1.0 is its own work, not this repo's. |
| ADR-041 (capability composition) | **Accepted but unimplemented**: `PatternKind` is still `'domain' \| 'orchestration'` (`src/patterns/pattern-definition.ts:47`); no `mixinImport`/`forwarderMethods`; clean-lite-ps still takes the base from `patterns[0]` (`prompt-extension.js:86-107`). | Unit 4 has a hard prerequisite: implement ADR-041 first. |
| `analytics:` vocabulary | Parse-only. Nothing outside `src/schema/` reads `analytics`, `measure_packs`, `analytics_aggregation`, or `generate.analytics: cube`; no fixture or example declares an `analytics:` block; no cube emitter exists. | Unit 3 replaces the vocabulary rather than extending it (CLAUDE.md: no backwards compat). |
| `docs/relationship-pattern-audit.md` §4 | Records resolution "cgp-62 r4 Q5: keep `relations()` emission as-is". | Unit 1 suspends that resolution by dependency force; needs a dated revision note, not silent removal. |

---

## 2. The access-pattern contract — tradeoff record (decided: option 1, ADR-044)

**What is being decided.** Whether generated repositories traverse a Drizzle v2 relation graph, or whether cross-entity
access stays service-layer composition over single-table repositories (the cgp-62 r4 contract, `docs/relationship-pattern-audit.md` §1, `.ai-docs/plans/codegen-app-patterns.yaml` `architectural_notes.cross_entity_access`).

**Why the current contract exists (verified rationale).** ElectricSQL parity: tables replicate 1:1 and the client
composes locally, so backend composition mirrors client composition — one pattern, same query count, same pagination
semantics on both sides (`codegen-app-patterns.yaml` `rationale`). Per-entity `sync: electric` is still a live
frontend-emitter option (ADR-038). The contract is a doctrine choice, not an accident.

| | 1 · Promote relations to core | 2 · Keep both; relations first-class opt-in | 3 · Split by surface (reads traverse, writes compose) |
|---|---|---|---|
| **What unit 2 emits** | `defineRelations()` manifest **plus** repository/service methods that use RQBv2 (`db.query.X.findMany({ with })`) for every `has_many`/`belongs_to`/junction traversal | `defineRelations()` manifest as table metadata only; generated services unchanged (FK + repo composition) | Manifest + RQBv2 on read use-cases/query classes only; write use-cases keep composition |
| **Doctrine change** | Reverses cgp-62 r4 §1; the audit's "generated service methods MUST NOT use `with:`" rule is deleted | None; upgrades the existing opt-in slot | Partial reversal; two access patterns by surface |
| **Electric parity** | Broken for traversals: client composes, backend joins. Either drop `sync: electric` for traversal shapes or keep a second code path | Preserved | Preserved for writes; reads diverge unless `sync: electric` entities are excluded from traversal emission |
| **One-declaration thesis** (YAML → ORM graph → semantic model → app layers) | Fully realized: the graph is what every layer projects from | Graph exists but the app layers do not project from it — "how do I get from A to B" has two answers (graph vs service) | Realized for reads only |
| **Fan-out safety** | RQBv2 traversal is safe for row shapes; aggregations still cannot ride RQB (documented limitation). The semantic model (unit 3) remains the only aggregation path | Same | Same |
| **Blast radius in this repo** | Largest: clean-lite-ps `service.ejs.t` composition (CGP-358b), clean `repository.ejs.t`, the `queries:` forwarders, both smoke harnesses, baseline snapshots, the audit doc, ADR-001's layering notes | Smallest: emitter + snapshots + audit §4 revision | Medium: read/write use-case split already exists in the clean pipeline (commands vs queries); clean-lite-ps has no such split |
| **Interaction with ADR-042/043** | Traversal must carry tenant scope through nested `with` (v2 predefined `where` filters can bake it in) — new surface for the guard | None new | Reads only; same concern as 1 for reads |
| **Interaction with unit 4** | Role edges (`roles:`) become named v2 relations with `alias`, and role finders can be RQBv2 traversals | Role finders stay repo-composed; `alias` is metadata | Reads via graph |
| **Interaction with unit 3** | None structural: the semantic model is derived from YAML either way; traversal choice does not change `AggregateModel` | Same | Same |

**What is true regardless of the choice** (so units 1, 3, 4 can proceed):
- `defineRelations()` is one central manifest per schema in every option; only *who consumes it* differs.
- The v1 consts must be removed from emission on 1.0 (unit 1, §4.2). Removing an opt-in extension with no generated
  consumers is not a doctrine change; deciding what fills the slot is.
- The semantic model's cardinality graph is derived from `relationships:` + `Junction`, not from Drizzle.

**What the ADR must record** (proposed **ADR-044 — Cross-entity access contract under Drizzle relations v2**):
the option chosen; the fate of the Electric-parity rationale; whether the audit doc §1/§4 is superseded; the
v2 `alias` source (`inverse` vs unit 4's `roles:`); whether junction traversal uses `.through()`; and the
tenant-scope mechanism for nested traversal if options 1 or 3. Number is free (`docs/adrs/` ends at 043 — check
again before minting; two ADR-031s already exist).

---

## 3. Sequencing and proposed PR list

```
DRZ-1 ──► DRZ-2 ──┬──► REL-0 ──┬──► TEN-1 ──► REL-1 ──► REL-2 ──► REL-3 ──► FE-REL
                  │            └──► CAP-1 ──► CAP-2 ──► CAP-3   (roles: feed v2 `alias`; REL-1 reads them if landed)
                  └──► SEM-1 ──► SEM-2 ──► SEM-3        (+ QS-1 in the query-surface repo)
```

| Key | Unit | PR title (proposed) | Size | Depends on |
|---|---|---|---|---|
| DRZ-1 | 1 | `feat(emit): drop v1 relations() const emission — the slot Drizzle 1.0 removes` | S | — |
| DRZ-2 | 1 | `chore(drizzle): 1.0.0-rc.4 — generator, runtime, scaffold, smoke` | M | DRZ-1 |
| REL-0 | 2-pre | `refactor(runtime): BaseRepository generic over its concrete table (#603)` | L | DRZ-2 |
| TEN-1 | 2-pre | `feat(runtime): ADR-042 — ALS-fed repository tenant scoping (tenant_scoped: true, strict enforcement)` | M | REL-0 |
| REL-1 | 2 | `feat(emit): defineRelations() manifest from relationships: + Junction; wire drizzle({ client, relations })` | M | DRZ-2 |
| REL-2 | 2 | `feat(repo): typed with-includes on generated repositories — scoped + soft-delete-filtered at every hop` | L | REL-0, REL-1, TEN-1 |
| REL-3 | 2 | `refactor(clean-lite-ps): relationship methods + typed navigator delegate to graph traversal; delete CGP-358b cross-repo injection` | L | REL-2 |
| FE-REL | 5 | `feat(frontend): graph accessors — has_many / junction traversal + typed include over TanStack DB collections` | L | REL-1 |
| QS-1 | 3-ext | *(query-surface repo)* `drizzle 1.0 peer; has_one; publish; introspection off v1 Relations` | M | — |
| SEM-1 | 3 | `feat(schema): analytics vocabulary → field tags (role/agg/aggs/additivity/time) + catalog metrics` | M | DRZ-2 |
| SEM-2 | 3 | `feat(emit): semantic model emitter — declared AggregateModel from the entity set` | L | SEM-1 |
| SEM-3 | 3 | `test(smoke): CRM vertical slice with analytics tags — emitted model type-checks and answers a fan-out-trap measure` | M | SEM-2 |
| CAP-1 | 4 | `feat(patterns): kind:'capability' + composed-base emission (ADR-041 implementation)` | L | DRZ-2, REL-0 |
| CAP-2 | 4 | `feat(schema): roles: block — role → (actor entity, cardinality) on communication entities` | M | CAP-1 |
| CAP-3 | 4 | `feat(runtime+patterns): Actor + Communication capabilities (mixins, explicit scope)` | L | CAP-2 |

The three tracks after DRZ-2 (REL, SEM, CAP) are independent. Sizes: S ≈ one sitting, M ≈ one day, L ≈ two to three days including fixtures and docs. Each PR carries its spec update (CLAUDE.md
"living documentation") and the gate output from the final run before commit (charter §9).

Why DRZ-1 before DRZ-2: DRZ-1 is green on 0.45 *and* 1.0 (it only deletes emission), so it isolates the snapshot churn
from the dependency bump. DRZ-2 then fails nowhere on the removed API.

---

## 4. Unit 1 — Drizzle 0.45.2 → 1.0.0-rc.4

### 4.1 Scope
The generator, its runtime, the scaffold it emits, and the harnesses that compile them. **Not** consumer migration
history, **not** a production pin for any consumer (charter §5).

### 4.2 DRZ-1 — drop v1 `relations()` emission

Inventory (verified):
- `templates/entity/new/backend/database/schema.ejs.t:13` (import) and `:225-244` (const).
- `templates/entity/new/clean-lite-ps/entity.ejs.t:16` (import) and `:85-98` (const); `prompt-extension.js:648-650`
  (`imports.add('relations')`), `:1343` (`hasRelationsBlock`), and the `clpHasRelationsBlock` local it feeds.
- `templates/junction/new/entity.ejs.t:11`, `:107-125`; `templates/junction/new/prompt.js:116`.
- `templates/entity/new/clean-lite-ps/service.ejs.t:107` comment referencing the const.
- Snapshots: 6 `test/baseline/**` files, `test/junction/__snapshots__/*.snap` (2), any `test/integration-emit` hits.
- Docs: dated revision note on `docs/relationship-pattern-audit.md` §4 ("resolution Q5 suspended 2026-09: the v1 API
  is removed by Drizzle 1.0; the slot is re-filled by unit 2 under ADR-044"); CHANGELOG entry.

Keep: everything relationships drive today that is not the const — FK columns, indexes, `on_delete`, the
CGP-358b service composition, `queries:` forwarders.

**Decided 2026-09-17: (A).** The two options considered:
- **(A) Remove and leave empty until unit 2.** Recommended. Keeps unit 1 mechanical; nothing in generated code
  consumes the const; no shape is pre-decided.
- **(B) Emit a metadata-only `defineRelations()` manifest now** (option-2 shape). Gets a v2 graph into consumers
  earlier and lets the "round-trips" gate run sooner, but does half of unit 2 before ADR-044 and pre-decides the file
  layout and `alias` source. Not recommended; noted because it is the smallest path to the charter §9 round-trip gate.

### 4.3 DRZ-2 — the bump

> **Shipped 2026-09-17. `docs/specs/DRZ-2.md` is the post-implementation truth**; the sub-section below is the
> pre-implementation plan, corrected where it was wrong. Read the spec's "1.0 API surface we depend on" table (A1–A9)
> before any later RC/GA bump, and its §Found-during-implementation before assuming anything here is still current.
> Three things every later unit needs to know: (1) `BaseRepository.table` is still `PgTableWithColumns<any>` and
> cannot be narrowed without making the class generic over its table — #603, which REL-2/REL-3 will have to resolve
> anyway; (2) the smoke harnesses no longer filter tsc output by message, so any new emission that does not compile
> fails a gate immediately (`test/smoke/_consumer-errors.ts`); (3) the generated typed event bus's vendored sibling
> closure is now explicit in `VENDORED_RUNTIME_FILES` and must be extended if the emitted bus grows a `../` import.

- **`package.json`.** `drizzle-orm` is currently a `dependency` (not a peer) of `@pattern-stack/codegen`. In `package`
  runtime mode the consumer resolves the runtime from this package, so a bundled `drizzle-orm` creates exactly the
  dual-type-identity problem `init-scaffold.ts:118-135` documents. Recommend: move to `peerDependencies`
  (`"drizzle-orm": "^1.0.0-rc.4"`, which admits GA `1.0.0`) plus a `devDependency` pin for this repo's own compile.
  Flag: this is a packaging correction that rides the bump; it is not a consumer production pin.
- **Emitted database module** (`src/cli/shared/init-scaffold.ts:204-230`): `drizzle(pool, { schema })` →
  `drizzle({ client: pool })` (relations are passed via `relations:` once unit 2 emits them); replace
  `ReturnType<typeof drizzle<typeof schema>>` with `NodePgDatabase` (or the driver's inferred type without the schema
  generic). Vendored `types/drizzle.ts` stays as-is.
- **Runtime.** `bun run typecheck` includes `runtime/**` — expect the deep type errors the smoke filters currently
  hide (`test/smoke/run-smoke.ts:150-153`, `:621-624` describe a 0.30↔0.45 "mismatch" class). Fix them for real;
  do not carry the filters. This overlaps **#576** (the `../` / `node_modules/` filter drops unresolved relative
  imports) — DRZ-2 should delete `filterConsumerErrors`'s path and `.schema.ts` exclusions and report the true tsc
  surface. If a genuine runtime-only error class remains, it gets its own issue, not a filter.
- **Rename** `getTableColumns` → `getColumns` in `src/__tests__/runtime/subsystems/{integration-audit,job-orchestration,bridge-delivery}.schema.spec.ts`.
- **Harness pins.** `test/smoke/run-smoke.ts:94` and `run-smoke-subsystems.ts:50` (`drizzle-orm@0.45` →
  `drizzle-orm@1.0.0-rc.4`); `test/scaffold/package.json` (`^0.30.0` / `drizzle-kit ^0.21.0` — both stale even for
  0.45); `test/post-publish` tarball smoke inherits the peer range. `pg@8` unchanged.
- **drizzle-kit.** The generator does not run kit (only `dev.ts:284` shells `drizzle-kit push`). Add the verified
  rc.4 folder layout to `docs/consumer/` so a consumer knows what `generate` now writes.
- **Docs.** CHANGELOG (next minor bump — `origin/main` shipped 0.30.0 on 2026-09-16, so 0.31.0: generated output changes); README dependency table; CONSUMER-SETUP
  troubleshooting entry for the "0.30/0.45 mismatch" is replaced, not appended to.

### 4.4 Acceptance
- `bun run typecheck`, `bun run build`, `bun run test` green with **no** filtered error classes.
- `just test-unit`, `just test-baseline`, `just test-junction`, `just test-smoke`, `just test-smoke-junction`,
  `just test-smoke-subsystems`, `just test-integration` (Docker) green.
- Generated project boots and serves `/docs-json` with non-empty component schemas (`test/smoke/verify-openapi.ts`
  already asserts this).
- `just test-post-publish` green (tarball peer range resolves).

---

### 4.5 Checkpoint 1 — what unit 1 actually surfaced (2026-09-17)

Specs `DRZ-1.md`, `GATE-1.md`, `DRZ-2.md`, `GATE-2.md` are the post-implementation truth; this is the digest that
changes later units. Full list: epic #579 › "What downstream must know".

- **The bump itself was small** (3 type errors, 4 specs) — the cost was in gates that had rotted. Three were red on
  `main` and outside CI (GATE-1, #599); the smoke `tsc` filters matched on error *message* and hid real generated-code
  errors (#575, #576); `test-smoke-integration` printed errors it did not gate on (GATE-2, #604). All now fail loudly.
  Consequence for every later unit: **new emission that does not compile fails a gate immediately.**
- **The relations slot is a named seam.** Emitted `database.module.ts` is `drizzle({ client: pool })` with
  `export type DrizzleDB = NodePgDatabase`; 1.0 removed `schema` from the pg config. REL-1 passes `relations` and
  parameterises `DrizzleDB` and `runtime/types/drizzle.ts` with the manifest's type (`TRelations`).
- **`BaseRepository.table` is `PgTableWithColumns<any>` and cannot be narrowed in place** (#603): the obvious narrowing
  passes `bun run typecheck` and breaks generated code under consumer tsconfigs. → REL-0 (§5A.0).
- **jsonb mapping changed in 1.0:** Drizzle no longer serializes `jsonb`; the driver does. Specs asserting captured
  params assert the object. Relevant to TEN-1/REL-2 tests that capture SQL, and to any non-`pg` driver path.
- **`getColumns`** replaces `getTableColumns` — SEM-2 and REL-0 use it.
- **`paths.*` config keys are declared once**, in `PathsConfigSchema`; the CLI type derives from it. SEM-2 / REL-1 add
  output paths there.
- **`drizzle-orm` is pinned in exactly one place** (root `package.json`); fixtures resolve by walking up. Do not add a
  second declaration in any harness.
- **The `clean` pipeline is known-red (#602)** and out of scope; do not mistake its failures for regressions.

## 5. Unit 3 — semantic / aggregate model emitter

### 5.1 Target shape (confirmed against the sibling package)

The package is host-supplied-model by design: the host injects `AggregateModel` via
`QueryServiceOptions.aggregateModel` (`presentation/nest/options.ts:91`). The shape (`adapters/drizzle/registry/model.ts`):

```
AggregateModel {
  registry:    Record<name, EntityDescriptor>   // name, table, primaryKey, columns, relationships{kind: belongs_to|has_many, target, fk},
                                                // searchableColumns, fieldMeta?, meta?{kind: entity|junction, summary}, eav?, computed?
  analytics:   AggRegistry                      // per entity: table, pk, rels, fields{type, role, agg, aggs, additivity, time, column, hasDeclaredDomain}
  tables:      Record<name, PgTable>
  colByDbName: Record<name, Record<dbCol, PgColumn>>
  catalog?:    MeasureCatalog                   // atomic (derived from role:'measure' tags) | ratio | derived(expr tree) | cumulative
}
```

Everything above is constructible from the parsed entity set plus the generated table objects. The package's own
`buildRegistry`/`registerSchema` recover the same data by walking v1 `Relations` — which is exactly what 1.0 removes —
so the emitter **declares** the registry from YAML instead. That is also the correct architecture: YAML is the source
of the cardinality graph; introspection was the package's workaround for hosts without one.

### 5.2 SEM-1 — vocabulary

> **Shipped 2026-09-17 (#590). `docs/specs/SEM-1.md` and ADR-045 are the post-implementation truth**; this section is
> the pre-implementation plan, corrected below where it was wrong. Three things later units need: (1) an atomic measure
> key is `<field>.<agg>` when the field declares `aggs:` and the bare `<field>` when it declares a single `agg:` —
> `deriveAtomicMeasureKeys` in `src/parser/validate-semantic.ts` is the one derivation, and SEM-2 must NOT emit atomic
> catalog entries because the package derives them; (2) `FieldDefinitionSchema` is now `.strict()`, so any later unit
> adding a field key must declare it; (3) the cube runtime island and the `@cubejs-client/core` peer are deleted.

Replace, do not extend (nothing consumes the current keys; see §1):

| Today (`SemanticMetadataSchema`, field level) | After | Notes |
|---|---|---|
| `measure: true` + `analytics_aggregation` | `role: measure` + `agg` (one) **or** `aggs` (allowed set) | the field IS the measure; aggregation is config on it. Built as mutually exclusive, not "and/or": the package's `meta.aggs ?? [meta.agg]` would silently drop `agg`, and the two produce different catalog keys |
| `dimension: true`, `dimension_type: categorical` | `role: dimension` | `hasDeclaredDomain` derives from `choices`/pg-enum at emit time |
| `dimension_type: time`, `time_granularity`, `agg_time_dimension`, `is_partition` | `time: true` | grains are query-time in the package; validated on `date` / `datetime` only — those are the repo's only temporal field types, there is no `timestamp` — and rejected on a measure |
| `non_additive_dimension` (MetricFlow shape) | `additivity: additive \| semi \| non` | **required** when `role: measure` — additivity cannot be inferred from `number` |
| `entity`, `entity_type`, `entity_role`, `semantic_expr`, `semantic_label`, `analytics_visibility` | dropped | keys/roles come from `relationships:`; label/visibility already ride `ui_*` (ADR-040) |
| `AnalyticsAggregationSchema`: `average, median, percentile, sum_boolean` | `avg`; the other three dropped | package `Agg` = `count \| count_distinct \| sum \| avg \| min \| max` |

Entity level (`AnalyticsBlockSchema`): drop `measure_packs` and `cube_name` (undefined anywhere); keep `metrics:` but
retype to the catalog's composite kinds: `ratio { numerator, denominator }`, `derived { expr }` where `expr` is the
closed 4-op tree over atomic measure refs (today's `expr: string` + `metrics: string[]` becomes a parsed tree — either
author it as a tree in YAML or add a tiny parser; recommend the tree, it is what the package validates), `cumulative
{ measure, order_by, partition_by }`. `simple` metrics disappear: they are the field tags.

Config: `generate.analytics: none | cube` → `generate.semantic: boolean` (default false), mirroring
`generate.frontend`. `@cubejs-client/core` leaves `peerDependenciesMeta` — **and `peerDependencies` and
`devDependencies`**: its only consumer was `runtime/subsystems/analytics/cube-backend.ts`, so dropping the peer while
keeping the lazy import would ship an undeclared dependency. SEM-1 deleted the whole cube island
(`runtime/analytics/**`, `runtime/subsystems/analytics/**`, its spec). `runtime/base-classes/with-analytics.ts` —
the unrelated `analytics?: any` DI slot on every generated service — stays.

Parser: mirror `parseUiMetadata()` in `src/parser/load-entities.ts` with `parseAnalyticsMetadata()` →
`ParsedField.analytics` (always present, every key optional, like `ParsedField.ui`); `ParsedEntity.analytics` for the
composite block. Validation splits in two, and the split is not optional: per-file rules (`role: measure` requires
`agg`/`aggs` and `additivity`; `time` requires a temporal type and not a measure; expression-tree structure) are Zod
refinements, while **leg resolution is cross-entity** — the catalog is one flat namespace, so a metric may name legs on
another entity, and measure keys and metric names must be unique across the whole set. That half lives in
`src/parser/validate-semantic.ts`, a pure `ParsedEntity[] → AnalysisIssue[]` function mirroring `validate-emits.ts`,
wired into both `analyzeDomain()` (so `entity validate` reports it) and the `entity new` pre-flight (so it gates).
Note also: the E1 "a derived expression must reference a measure" rule sits on the entity-level block, not on the
metric — a Zod discriminated union may not hold a refined (`ZodEffects`) member.

### 5.3 SEM-2 — emitter

> **Shipped 2026-09-17 (#591). `docs/specs/SEM-2.md` is the post-implementation truth**; this section is the
> pre-implementation plan. Three corrections: (1) the **fallback path was taken** — the package is still unpublished
> AND still has no `has_one`, so `types.ts` is emitted as a mirror and the conformance test carries a named
> `has_one` expectation; (2) a junction's table const is **camelCased** (`opportunityContacts`) while an entity's is
> the raw plural (`deal_states`) — the two templates disagree and any emitter referencing a table identifier must
> too; (3) the conformance test asserts a **sound narrowing**, not declaration identity — an emitted model must be
> assignable to the package's types, and demanding identity would force the mirror to carry EAV and
> expression-measure machinery the emitter never populates.

New whole-set emitter `src/emitters/semantic/` shaped like `src/emitters/frontend/` (`loadSemanticEmitContext` +
`emitSemanticModel(ctx, outDir)`, name-sorted entities, complete-file writes with the `@generated` banner). Post-step
in `src/cli/commands/entity.ts` next to the frontend block (`:827-866`), same warn-but-print contract; output root
under `paths.generated` (`src/generated/semantic/`).

Emitted files:
- Types are imported from the published `@pattern-stack/query-surface` (optional peer, gated by `generate.semantic`)
  — no vendored mirror. **Fallback only if query-surface#40 slips past SEM-2:** emit `types.ts` as a verbatim mirror of
  `AggregateModel` / `EntityDescriptor` / `AggFieldMeta` / `MeasureCatalog` (the ADR-040 precedent) plus a conformance
  test that type-checks the mirror against a path-linked sibling checkout.
- `model.ts` — as built, `<generated>/semantic/model.ts`, importing the generated tables from the schema barrel
  and exports `buildAggregateModel(): AggregateModel` assembling registry, analytics, `tables`, `colByDbName` (via
  `getColumns`), and the catalog. Junction pattern entities emit `meta.kind: 'junction'` with two `belongs_to`
  descriptors; each endpoint gets the inverse `has_many`. `searchableColumns` = text fields not FK/enum/id (the
  package's own derivation rule, replicated).
- `index.ts` barrel.

Mapping rules that need a decision (recommendation first):
- **`has_one`** → emitted faithfully; the package gains the kind in query-surface#40. Fallback if that slips: emit as `has_many` (the package has no `has_one`; treating it as to-many is *conservative* for the
  grain oracle — it can only refuse a sum it would otherwise allow). Alternative: extend the package.
  *Measured at SEM-2 (2026-09-17):* query-surface#40 has **not** started — `grep -rn has_one src/` in the sibling
  checkout is empty and the `dugshub/40-drizzle-1-0-has-one` branch sits at `origin/main`'s tip. SEM-2 emits
  `has_one` and the conformance test's named expectation is the tripwire; the fallback remains one line in
  `build-model.ts`.
- **`through:` (transitive relationships)** → not emitted in SEM-2; the package resolves multi-hop paths itself.
- **Tenant/scope columns** (`tenant_id`, `organization_id`, `user_id` from `user_tracking`) → `role: dimension`,
  `ui_visible: false` parity, never a measure. `TENANT_GLOBAL` decisions are host-side (`scopeFor`), not emitted.
  *As built:* "never a measure" holds by construction — a measure is only ever a field the YAML tags — and the
  explicit dimension role is derived for those three column names.
- **EAV** (`examples/eav`) → out of scope for SEM-2; the descriptor's `eav?` stays unset. Note in the spec.

### 5.4 SEM-3 — the demonstration gate

> **Shipped 2026-09-17 (#592). `docs/specs/SEM-3.md` is the post-implementation truth.** The plan's optimistic branch
> ("If the sibling package is linkable in CI, run its `describe` and one `measure`…") does **not** hold: the package
> cannot be loaded against drizzle-orm 1.0 at all — `src/index.ts` transitively value-imports `createMany`/`createOne`,
> which 1.0 removed. The suite is written in full and **skips with a printed reason** naming the missing export; it is
> in `just test-semantic-integration` and the CI `integration` job so the skip is visible.
> **Review fix (2026-09-19, PR #622):** against query-surface#41 (the 1.0 fix) the emitted model first went 5/4 —
> `account.name` was untagged and so not groupable; tagged, it is **9/9**. CI still skips: no engine is installed
> there. The suite resolves an installed `@pattern-stack/query-surface` first, so SEM-4 turns it on by adding the
> devDependency — one item of the measured nine-item retirement list in `docs/specs/SEM-2.md` §4.
> Two further things every later unit needs: (1) `needsCte` is `sources.length > 1`, so the fan-out trap needs a
> measure at the PARENT grain beside the one over the `has_many`; (2) never probe the sibling checkout without
> staging it — it has no `node_modules`, so `bun <script>` auto-installs 0.45 and hands you a 0.45 answer.

Fixture: extend the existing CRM smoke fixtures under `test/smoke/fixtures/crm/` (account, contact, opportunity) with
the junction shapes already in `test/fixtures/junctions/`, then add analytics tags: an additive money measure with
`aggs: [sum, avg, min, max]`, a non-additive percentage (`additivity: non`), a `time: true` axis, and one ratio in
`metrics:`. Assertions: emitted `model.ts` type-checks in the smoke project; the conformance test passes against the
sibling checkout; a snapshot suite `test/semantic-golden/` locks the emitted files (frontend-golden precedent). If the
sibling package is linkable in CI, run its `describe` and one `measure` with a fan-out trap (sum over a `has_many`
grouped at the parent grain) and assert the plan reports `needsCte: true` and correct rows — otherwise record that
step as a manual gate in the spec.

### 5.5 Open questions (charter §7) — with recommendations
- **Where does the metric catalog live: YAML or the consuming adapter?** Recommend **YAML for atomic tags and
  composites that are pure functions of declared fields** (ratio/derived/cumulative over named measures), **adapter
  for anything data-driven** (declared domains harvested from live data, EAV overlays). The catalog is then emitted,
  and the adapter's `catalog` merge is additive on top.
- **Additivity per measure, per pack, or both?** **Per field.** The package's registration rule ("a def may tighten
  additivity but never loosen it", `measure-catalog.ts:99-115`) only works when the field carries the truth.
  *Corrected at SEM-1:* the packs **were** defined — `runtime/analytics/packs/{crm-entity-measures,monetary-measures}.ts`
  are the `crm_entity` / `monetary` referents. Same conclusion (delete the key), different reason: packs are a
  cube-era indirection, not an undefined one. They were deleted with the rest of the cube island.

*Q4 was decided by default at SEM-1 per the recommendation above, and is recorded in ADR-045 §Decision 7. It is
flagged for owner confirmation: reversing it means moving the composite metric schema out of the entity YAML.*

---

### 5.6 QS-1 — changes in the query-surface repo (operator-owned)
Verified state: `private: true`, peer `drizzle-orm ^0.45.2`, Drizzle adapter walks v1 `Relations`
(`registry/introspect.ts`, `registry/schema-registry.ts`) — the API 1.0 removes. Work: bump the peer to the 1.0 line;
make introspection walk `defineRelations()` output or mark it a non-codegen-host path (codegen hosts supply the declared
model); add `has_one` to the relationship kinds; publish. Its tenancy hook (`scopeFor`, deny-by-default via
`tenantGlobalEntities`) should read the same `RequesterContext` ALS that ADR-042 feeds, so one boundary seeds both.

---

## 5A. Unit 2 — relations graph as the core contract (ADR-044)

### 5A.0 REL-0 (#603) — `BaseRepository` generic over its concrete table
Added at checkpoint 1. **As built, see `docs/specs/REL-0.md`** — that spec is the source of truth and supersedes this
section. In one line: `BaseRepository<TEntity, TTable extends PgTable>` (and every family repository and mixin, with
`TTable` always the second type parameter) holds `table: TTable` and reads columns through a typed `column()` helper,
replacing the `PgTableWithColumns<any>` that forced the `.returning()` / write-payload assertions. `TEntity` stays an
**independent, explicit** parameter: the checkpoint-1 wording here ("derive `TEntity` from `$inferSelect`, read columns
via `getColumns`") was evaluated and rejected — generated code already defines the entity as
`InferSelectModel<typeof table>`, and hand-written repositories legitimately pass a domain type that is not the row
shape (REL-0.md §1). Validated under the **consumer** tsconfig (`noUncheckedIndexedAccess`) via `just test-smoke`, not
`bun run typecheck` (charter I9). Prerequisite of TEN-1 (same choke point), REL-2 (typed includes) and CAP-1 (its
capability mixins are typed over `BaseRepository<any, PgTable>`). `clean-lite-ps` generated repos + vendored runtime
covered; the `clean` pipeline is not (#602).

### 5A.1 What "reads are generated" means
RQBv2 resolves a nested include tree from one root in a single statement, typed end to end:

```ts
// meeting → opportunity → account → that account's opportunities
meetingRepo.findById(id, { with: { opportunity: { with: { account: { with: { opportunities: true } } } } } })
```

So any row-shaped path through the YAML graph is a generated read — no hand-written query. It is an **include tree from
a root**, not lazy chained accessors: the result is one nested object. Per-relation `where` / `orderBy` / `limit` are
part of the include. Aggregation over a path is *not* this surface (fan-out; see unit 3).

### 5A.2 TEN-1 — implement ADR-042 first
Exactly the ADR: `RequesterContext.tenantId`, `getTenantId()`, `tenant_scoped: true`, predicate in `scopeAnd()`, stamp
on `create()`, jobs enter the ALS from `jobRuns.tenantId`. Default `scopeEnforcement: 'strict'` when
`tenant_scoped: true`. Traversal without this is a cross-tenant read path, hence the ordering.

### 5A.3 REL-1 — manifest — **shipped 2026-09-17 (#586)**
One `defineRelations()` manifest per schema under `paths.generated`, whole-set emitted (TS emitter, not hygen inject —
it is a cross-entity file; ADR-038 precedent). `belongs_to`/`has_many`/`has_one` from `relationships:`; junctions via
`.through()`. `init-scaffold.ts` database module passes `relations`. Gate: charter §9 round-trip (YAML → manifest →
traversal returns expected rows) in `test-integration`. `docs/specs/REL-1.md` is the post-implementation truth; what
changes later units:

- **No `alias`, ever.** The plan said "`alias` from `inverse`, and from `roles:` when CAP-2 has landed". Measured:
  Drizzle reads `alias` only in `processRelations`' reverse-inference branch, which runs only when a relation omits
  `from`/`to`. REL-1 emits explicit `from`/`to` on both sides of every relation, so self-references and multiple
  relations between the same pair need none. **CAP-2 (§6.3) adds role edges the same way — one more entry in
  `build-graph.ts`, explicitly keyed, no `alias`.** ADR-044 carries a dated revision note.
- **Relation keys are the YAML relationship names**, camelCased — not the target entity name the deleted v1 const
  used. REL-2's typed `with` and REL-3's navigator method names derive from these keys, so
  `meetingService.from(id).parentAccount()` follows the YAML, not the target.
- **The typed db is generated→generated.** `runtime/types/drizzle.ts` is now
  `DrizzleClient<TRelations extends AnyRelations = AnyRelations>` (the `any` is gone); the published runtime stays
  relations-agnostic because it can never see a consumer's manifest. The typed handle is `DrizzleDB =
  NodePgDatabase<typeof relations>` in the emitted `database.module.ts`. **REL-0/REL-2 bind their generic there**, not
  in the runtime package.
- **`paths.generated` was enough** — no new `paths.*` key. The manifest is `<generated>/relations.ts`, a sibling of
  `modules.ts` / `schema.ts`, and `project init` writes the empty shape so a zero-entity project compiles.
- **`expose_on_parent` does not gate the graph.** It is CGP-60's parent-service fan-out knob; every declared
  relationship is navigable internally (§5A.6). REL-2's HTTP allowlist is the separate knob.
- **A relation-key collision fails the command.** Two declarations claiming one key on one table (e.g. a declared
  `contacts: has_many` plus an `opportunity × contact` junction) throws; the post-step reports an error and
  `entity new` exits non-zero. Later units that add edge sources must keep that property.
- **`relationship:` YAML entities contribute no edges yet.** Their typed edges need a per-type `where`, which is
  REL-2's surface; their tables carry `{}` in the manifest today.
- **The scaffold integration harness now generates a SET** — `test/scaffold/entities/` (account · contact ·
  opportunity) plus `test/scaffold/junctions/`, staged into `<repo>/junctions` because the CLI reads junctions from a
  fixed path. TEN-1 / REL-2 leak tests at depth ≥ 3 have a graph to traverse there already.

### 5A.4 REL-2 — typed includes on repositories
`findById` / `list` / declarative `queries:` accept a typed `with`. **Every hop** must carry: tenant predicate (ALS),
soft-delete filter, `userTracking` scope — spike whether v2 predefined relation `where` filters can bake these in, or
whether the repository rewrites the include tree before executing. Traversal must also respect ADR-043: an entity with
`api: false` or a stricter guard must not become readable *through* an exposed neighbour — so the HTTP surface takes an
**allowlisted, depth-capped** include (declared in YAML), never a raw client-supplied tree. Internal callers
(use-cases) get the full typed include.

### 5A.5 REL-3 — services delegate
Keep the public method names (`opportunityService.account(id)`, `accountService.contacts(id, page)`); bodies become one
graph call on the entity's own repository. Delete the sibling-repository constructor injection loop and the module
imports it forces. Delete the audit doc's "generated service methods MUST NOT use `with:`" rule with a dated note
pointing at ADR-044. Baselines + junction snapshots regenerate.

### 5A.6 Fluent navigation on the generated service (operator intent, 2026-09-17)
The service layer is where traversal is expected to surface (ADR-003: services own reads, including cross-domain reads
and convenience joins). REL-3 therefore also emits a typed **navigator**: a builder that accumulates an include tree
and executes **once**, never a lazy per-hop chain (which would be N queries and N scope checks):

```ts
meetingService.from(id).opportunity().account().opportunities({ limit: 20 }).fetch()
// compiles to the single §5A.1 include; return type is the nested shape
```

Navigator classes are generated per entity from the same graph as the REL-1 manifest (cycles are fine — each step
returns the target entity's navigator type). **Default: every declared relationship is navigable internally.** Two
separate knobs, not to be conflated:
- *Internal navigation* — default all. A later per-relationship opt-out (`navigable: false`) is possible if a consumer
  needs it; not built now. `relationships:` already plays the role dbt's semantic-layer `entities:` play (declaring the
  join keys is what permits the join path), so no second declaration is needed.
- *HTTP exposure* — allowlist + depth cap (§5A.4). Default none.

This is the relationship analogue of today's `queries: - by: [host_id]` → `findByHostId()`: first-class generated
functions from a YAML declaration, here derived from `relationships:` rather than listed.

**`queries:` stays.** Navigation subsumes only the FK-shaped finders (`by: [host_id]` ≈ `contact → hostedMeetings`).
`queries:` still owns non-relationship lookups (`by: [email]` unique, `by: [status]`, composites, `order:`) and the
index emission that rides them. Possible later lint: warn when a `by:` is a single FK already covered by a declared
relationship. Building on the 1.0 prerelease line is operator-approved (2026-09-17).

## 6A. Unit 5 — frontend graph accessors (FE-REL)

### 6A.1 Starting point (verified)
The ADR-038 emitter already emits per-entity TanStack DB collections (`electric` and `api` modes,
`emit-collections.ts`) and whole-set `belongs_to` resolvers + `<Class>Refs` hydration (`emit-store.ts`).

### 6A.2 Scope
Add `has_many` and junction traversal and a typed include API over live queries, generated from the same relationship
graph as REL-1, so `electric` entities traverse client-side and `api` entities can request the allowlisted include from
REL-2. This is what replaces the old "compose identically on both sides" parity rationale.

### 6A.3 Open — where the include API lives
Recommend `@pattern-stack/frontend-patterns` owns the mechanism (the `createEntityHooks` / `createStore` precedent) and
the emitter emits thin typed wiring. Alternative: fully generated. Operator to confirm; it makes FE-REL a two-repo unit.

---

## 6. Unit 4 — pattern-library extension (actor / communication split)

### 6.1 Reading of the ask
Communication-style entities (email, meeting, message, transcript) are interactions with **actors in roles**
(from/to/cc/host/attendee); record-style entities (account, opportunity, contact-as-record) are CRM objects with
owners and FKs. The existing `Activity` pattern already covers the *subject-scoped interaction* half
(`config: { Activity: { subject } }`). What is missing is (a) a declaration of who participates in what role, and
(b) an entity-side capability that says "this thing can occupy a role" — the `Individual`/`Group` lattice that
ADR-041 and `.ai-docs/research/subject-lattice-codegen-lift.md` already forward-designed. The split is therefore two
**capabilities** composing over the existing library, not new base classes:

- **`Actor`** (capability) — declares an entity can occupy roles; `config: { Actor: { kind: individual | group,
  members?: <has_many relation> } }`. `group` yields members as a predicate fragment (no materialized list).
- **`Communication`** (capability) — attaches to an interaction entity (typically `patterns: [Integrated, Activity,
  Communication]`); reads the `roles:` block; contributes role-edge finders.
- **Record-style** needs no new pattern: it is `Base`/`Integrated` as today.

### 6.2 CAP-1 — implement ADR-041 (prerequisite)
Exactly the accepted rulings, nothing more: `PatternKind` gains `'capability'`; `CapabilityPatternDefinition` with
`mixinImport` and/or `forwarderMethods`; spine selection by config-bearing base (not `patterns[0]`), hard error on two
spines; generation-time collision check across known vocabs; clean-lite-ps emits `<Entity>ComposedBase` when ≥2
capabilities stack, inline `extends Cap(Spine<...>)` for one; `assertHasContribution` accepts a mixin/forwarder
contribution. Scope to clean-lite-ps (ADR-041 §6). Regression guard: the 3-capability smoke fixture that compiles
against the real published bases (ADR-041 "Testing / safety").

### 6.3 CAP-2 — `roles:` block
Sibling block on the entity (the research recommends a sibling over annotating `relationships:`):

```yaml
roles:
  host:      { target: contact, cardinality: one,  column: host_contact_id }   # column optional → <role>_<target>_id
  attendees: { target: contact, cardinality: many, via: meeting_attendees }    # many → junction (Junction pattern) or has_many
  about:     { target: account, cardinality: one }
```

Schema (Zod, `.strict()`, superRefine): `target` must resolve to an entity that declares `Actor`; `cardinality: one`
derives a `belongs_to` (FK column + index + `on_delete`), `cardinality: many` requires `via:` naming a Junction between
this entity and the target. Parser → `ParsedEntity.roles`. Composition validator: a `roles:` block on an entity
without `Communication` is an error; `Communication` without `roles:` is an error.

Downstream hooks (kept minimal here; consumed by units 2 and 3): each role is a named relationship, so it feeds the
semantic model as a `belongs_to`/`has_many` descriptor with the role name, and is the natural source of v2 `alias` for
two roles targeting the same table (host vs attendee). CAP-2 records that mapping in its spec; unit 2 implements it.

### 6.4 CAP-3 — runtime mixins + library definitions
TS shape (charter I2/I3): **interfaces + generic constraints, behavior via mixins** (`runtime/base-classes/with-analytics.ts`
is the shipped precedent), no base-class chain. Proposed:

```ts
export interface RoleEdge { role: string; target: string; cardinality: 'one'|'many'; column?: string; via?: string }
export interface CommunicationConfig { roles: readonly RoleEdge[] }
export function WithCommunication<TBase extends RepoCtor>(Base: TBase) { /* findByRole(role, actorId), participants(id) */ }
export function WithActor<TBase extends RepoCtor>(Base: TBase) { /* memberPredicate(actorId) for group kind */ }
```

- **Tenant scope is ALS-fed (ADR-042), never a parameter** (charter I3). Capability methods compose their predicate
  through the repository's `scopeAnd()` like every other read.
- Library definitions `src/patterns/library/{actor,communication}.pattern.ts` with `kind: 'capability'`, Zod
  `configSchema`, `forwarderMethods` for the service-side pass-throughs, `mixinImport` for the repo side.
- Emission: `patternConfig.roles` literal on the concrete repo (the `renderPatternConfigLiteral` path
  `service.ejs.t:49`); a `Communication` entity's `roles` also drive FK columns via CAP-2.
- Fixture: `meeting` (`patterns: [Activity, Communication]`, roles host/attendees/about) over `contact`
  (`Actor: individual`) and `account` (`Actor: group`, members via `contacts`); smoke tsc + `just test-integration`
  round-trip of `findByRole('attendees', contactId)` (scope is ALS-fed, never a parameter).
  *Revised after checkpoint 1:* the originally proposed `[Integrated, Activity, Communication]` is a **hard error**
  under CAP-1 — `Integrated` and `Activity` are both inheritable spine bases, and ADR-041 allows exactly one
  (`pattern_multiple_spines`, `docs/specs/CAP-1.md`). Per ADR-041 §5, `Activity` is not dual-authored as a capability
  until a consumer needs it; CAP-3's spec records the fixture it actually uses.

### 6.5 Out of scope for unit 4
`to_shape` projections, selector/Find-target catalog, and shape registry from the subject-lattice research; any
change to the `Activity` pattern's subject semantics; the clean (full) pipeline (ADR-041 §6 defers it).

---

## 7. Gates (every PR)
`bun run typecheck && bun run build && bun run test` · `just test-unit` · `just test-smoke` (+ `-junction`,
`-subsystems` for DRZ-2/CAP-*) · `just test-integration` for anything touching emission (DRZ-1/2, SEM-2/3, CAP-1/3) ·
`/docs-json` non-empty (smoke `verify-openapi.ts`) · `just test-post-publish` for DRZ-2. Report the run made after the
last edit, immediately before the commit.

## 8. Documentation deliverables
- **ADR-044** — drafted 2026-09-17 with the operator's decision (option 1); §2 above is its input.
- **ADR-042** — status Proposed → Accepted 2026-09-17, with a revision note correcting its "consumers hand-author
  services" rationale (services are generated; the hand-written layer is use-cases).
- **ADR-045 — Semantic model emission: the entity YAML as the declared `AggregateModel`** (SEM-1/2): vocabulary
  replacement, declared-not-introspected registry, vendored type mirror, per-field additivity. Mint spec key `SEM-N`.
- **ADR-041 revision note** (CAP-1): "implemented 2026-09 in CAP-1; deviations: …". ADR-046 for the `roles:` block
  + Actor/Communication capabilities (CAP-2/3), or fold into ADR-041 as a dotted sub-ADR (`ADR-041.1`) — the
  project-documentation skill allows both; recommend the sub-ADR since the mechanism is ADR-041's.
- `docs/relationship-pattern-audit.md` §4 dated revision note (DRZ-1); CONSUMER-SETUP + CHANGELOG (DRZ-2).
- Specs: `docs/specs/DRZ-1.md`, `DRZ-2.md`, `SEM-1..3.md`, `CAP-1..3.md`, updated to post-implementation truth in the
  same PR.
- Skills: `.claude/skills/codegen/SKILL.md` routing table gains semantic + capability entries when they land.

## 9. Open questions
Tracked in `PROJECT.md` §7 (one place). Nothing is tracked here.
