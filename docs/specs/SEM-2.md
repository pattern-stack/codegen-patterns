# SEM-2 — the semantic model emitter: the entity YAML as a declared `AggregateModel`

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #591 · **Epic:** #581 · **Project:** #578
**Depends on:** SEM-1 (#590) · **Blocks:** SEM-3 (#592) · **Companion:** pattern-stack/query-surface#40
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5.1, §5.3, §5.6 · ADR-045

## Why

SEM-1 replaced the vocabulary; nothing emits it. The semantic-query layer is *host-supplied-model* by design — the
host injects an `AggregateModel` — so until codegen emits one, the tags are inert.

SEM-2 emits it, **declared** from the parsed entity set. The package's own adapter recovers the same data by walking
Drizzle's v1 `Relations` objects, which Drizzle 1.0 removed; more to the point, introspecting generated code to
recover what the YAML already says is exactly the duplication this project exists to delete (I1). The YAML is the
source of the cardinality graph. The emitter declares from it and never reads a table to learn a relationship.

## Charter invariants this PR touches

- **I1 declare once.** Every entry in `registry`, `analytics` and `catalog` derives from a YAML declaration.
  Nothing walks `relations()`, the emitted schema files, or the database to recover structure. The one place a
  Drizzle object is read is `getColumns(table)` — to obtain `PgColumn` *references*, which cannot be written down in
  YAML; the entity set, names, types, relationships and tags all come from the declaration. FK target names resolve
  through the cross-entity registry (the target's own `plural`), never re-pluralized at emit time.
- **I2 generated means regenerated.** `<generated>/semantic/*` are whole-set, complete-file writes with an
  `@generated` banner, name-sorted, byte-identical on re-run. No inject, no anchors, no author seam.
- **I7 no backwards compat.** No cube-era shim, no parallel model shape. The type mirror is a *pre-publication
  stand-in* with a named removal path (§4), not a compatibility layer.
- **I9 honest gates.** Golden snapshot + unit tests land in `just test-all`; the emitted model is type-checked inside
  a real smoke project. The sibling-checkout conformance test skips **with a printed reason** when the checkout is
  absent — a named, single-purpose skip, not a filter. No new `any`.
- **I11 scope discipline.** Cross-entity file ⇒ whole-set TS emitter (ADR-038 precedent), not a hygen inject. Gates
  are `clean-lite-ps`; the `clean` pipeline stays known-red (#602), neither repaired nor filtered.

## Verified before designing

Measured on this branch; the sibling package read at `/root/wt/sdlc-patterns/query-surface-40`.

| # | Claim | Evidence |
|---|---|---|
| S1 | The schema barrel is `export * from '<entity schema file>'` per entity, and each entity file exports `export const <entity.plural> = pgTable(…)`. So `import * as schema from '../schema'` yields table consts keyed by `plural`. | `buildSchemaBarrel` (`src/cli/shared/barrel-generator.ts`); `templates/entity/new/clean-lite-ps/entity.ejs.t:32`. |
| S2 | `getColumns(table)` exists on `drizzle-orm@1.0.0-rc.4` root export and returns property-keyed columns carrying `{ name (db), dataType, columnType }`. | Probe run **from inside the repo** (charter §8): `id → db=id dataType='string uuid' columnType=PgUUID`, `closed_at → dataType='object date'`. Probe deleted after measuring. |
| S3 | **1.0 changed `dataType` to a compound string** (`'string uuid'`, `'string numeric'`, `'string enum'`, `'object date'`), not the bare `'string'` of 0.45. | Same probe. Consequence in §3: the package's introspection-based `searchableColumns` heuristic (`col.dataType !== 'string'`) silently changes meaning under 1.0. Deriving from YAML is immune — a second reason the declared model is the right architecture, not just the ideological one. |
| S4 | `AggRegistry` keys, `AggRelationship.target`, `model.tables` and `model.colByDbName` are all keyed by the **registry key** (the host's logical entity handle); `colByDbName[entity]` is inner-keyed by **db column name**. | `reg[rel.target]` in `belongsToPaths` (`internal/analytics/join-plan.ts:53-56`); `model.colByDbName[source]![model.analytics[source]!.pk]` (`adapters/drizzle/compile/compile-drizzle.ts:283`) with `pk` a db name. |
| S5 | `AggEntity.table` has **no reader** in the package. | `grep` over `src/` for `.table` in the analytics internals: only `valueTable` (EAV) matches. Emitted as the db table name for legibility; nothing depends on it. |
| S6 | `AggFieldMeta` keys are field keys with `column` "defaulting to the field key", so the field key is the **db/snake column name**. | `internal/analytics/types.ts`; `analytics[source]?.fields[node.col]` is reached with a query-language column name. |
| S7 | **`has_one` does not exist in the sibling package yet.** `AggRelationship.kind` and `RelDescriptor` are `'belongs_to' \| 'has_many'`; `grep -rn has_one src/` returns nothing, and the `dugshub/40-drizzle-1-0-has-one` branch is at `origin/main`'s tip with no commits of its own. | Read + `git log` in the `-40` checkout, 2026-09-17. |

### What S7 means

PLAN §5.3 planned for this: *"`has_one` → emitted faithfully; the package gains the kind in query-surface#40.
Fallback if that slips: emit as `has_many`."* Publishing **and** `has_one` are both still ahead of us, so SEM-2
emits `has_one` faithfully and the conformance test carries a **named single-purpose expectation** naming
query-surface#40 — asserted present *and* sole, so it fails loudly the day the package gains the kind and tells us to
delete it. The fallback stays one line (§6) if the owner decides #40 will not land.

## Scope

### 1. New emitter — `src/emitters/semantic/`

Modelled on `src/emitters/frontend/` (ADR-038) and on REL-1's `src/emitters/relations/` (#614): pure builders, no fs
below `index.ts`, a context loader that owns path resolution.

```
src/emitters/semantic/
  types.ts          SemanticEmitContext + the intermediate model shapes
  build-model.ts    ParsedEntity[] + junctions → SemanticModel   (the ONLY place semantics live)
  emit-types.ts     the verbatim type mirror → types.ts source
  emit-model.ts     SemanticModel → model.ts source
  emit-index.ts     the barrel source
  load-context.ts   loadSemanticEmitContext(cwd, config, { entitiesDir, junctionsDir })
  index.ts          emitSemanticModel(ctx, outDir) → EmitSemanticResult; re-exports
```

plus `src/cli/shared/semantic-generator.ts` — `regenerateSemanticModel({ ctx, entitiesDir, junctionsDir,
generatedDir, dryRun })` — so the CLI has one call site rather than the loader wiring inline.

**Context.** Unlike REL-1, which needs the raw `EntityDefinition` to recover `nullable:`, SEM-2 consumes
`ParsedEntity` — SEM-1 put the analytics tags on `ParsedField.analytics` / `ParsedEntity.analytics` precisely so
downstream emitters read one shape. The registry supplies naming.

```ts
interface SemanticEmitContext {
  entities: EntityRegistryEntry[];          // name-sorted; the only naming source
  parsed: Map<string, ParsedEntity>;        // tags, fields, relationships
  junctions: JunctionDefinition[];          // sorted by derived junction name
}
```

**Ordering** is total and derived: entities by `name`, junctions after entities by junction name, fields and
relationships by key. Re-running is byte-identical.

**Output paths.** No new config key: `<paths.generated>/semantic/`, resolved through the existing
`resolveGeneratedDir` — `paths.generated` is already declared once in `PathsConfigSchema`, and adding a second key
for a subdirectory of it would be the duplication GATE-1 (#599) was about.

### 2. What is emitted

`<generated>/semantic/model.ts`:

```ts
// @generated by @pattern-stack/codegen — do not edit.
import { getColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../schema';
import type { AggregateModel, AggRegistry, EntityDescriptor, MeasureCatalog } from './types';

const tables: Record<string, PgTable> = {
  account: schema.accounts,
  opportunity: schema.opportunities,
  // …
};

/** db-column-name → column, per entity. The one place a Drizzle object is read. */
const colByDbName: Record<string, Record<string, PgColumn>> = Object.fromEntries(
  Object.entries(tables).map(([name, table]) => [
    name,
    Object.fromEntries(Object.values(getColumns(table)).map((c) => [c.name, c as PgColumn])),
  ]),
);

const registry: Record<string, EntityDescriptor> = { /* declared */ };
const analytics: AggRegistry = { /* declared */ };
const catalog: MeasureCatalog = { /* declared composites */ };

export function buildAggregateModel(): AggregateModel {
  return { registry, analytics, tables, colByDbName, catalog };
}
```

`registry[x].columns` is `getColumns(tables[x])` — property-keyed `PgColumn`s, matching what the package's own
builder puts there.

`<generated>/semantic/index.ts` re-exports `buildAggregateModel` and the types.

### 3. Mapping rules

Keys: **registry / analytics / tables / colByDbName are keyed by the entity name** (singular snake), and a junction by
its derived junction name (`opportunity_contact`). Relationship keys are the **YAML relationship names verbatim**
(snake_case), not camelCased — the query language is snake_case throughout, and field keys already are. (REL-1
camelCases its relation keys because Drizzle needs JS identifiers; that constraint does not apply here.)

| Source | Emitted |
|---|---|
| entity | `registry[name] = { name, table: schema.<plural>, primaryKey: 'id', columns, relationships, searchableColumns }`; `analytics[name] = { table: <entity.table>, pk: 'id', rels, fields }` |
| `belongs_to T` fk `f` | `{ kind: 'belongs_to', target: T, fk: f }` in both `relationships` and `rels` |
| `has_many T` fk `f` | `{ kind: 'has_many', target: T, fk: f }` — `f` is the FK **on the target** |
| `has_one T` fk `f` | `{ kind: 'has_one', target: T, fk: f }` — faithfully; see S7 / §4 |
| `through:` (transitive) | **not emitted** — the package resolves multi-hop paths itself from the one-hop graph (PLAN §5.3); emitting a synthetic edge would invent a join the YAML never declared |
| junction `between: [A, B]` | a registry entry keyed by the junction name with `meta: { kind: 'junction' }` and two `belongs_to` descriptors (`a` → A fk `a_id`, `b` → B fk `b_id`); **and** on each endpoint an inverse `has_many` keyed `<junction.plural>` with fk `<endpoint>_id` |
| junction columns | `analytics.fields` holds **exactly the columns `templates/junction/new/entity.ejs.t` emits**: the two FKs; `role` when `fields.role.choices` is non-empty (→ `role: 'dimension'`, `hasDeclaredDomain`, derived like a scope column because it is the junction's identity); `is_primary`; `started_at` / `ended_at` when `temporal` (default true); `sourced_from` / `confidence` / `matched_at` when `sourced` (default true); every other `fields:` payload entry, typed as the template types its column (enum only with non-empty `choices:`, else by `type:`, unmapped → `string`); `created_at` / `updated_at`. **No `id`** — a junction has none. Junction YAML has no analytics tag vocabulary, so none of these is a measure. `searchableColumns` stays `[]` — junction rows are not a full-text target. |
| junction key | the table's key is **composite** — `(a_id, b_id[, role])` — and the package's `primaryKey` / `pk` is one column name. The emitter keeps `'id'` there, which names no column: a query or measure **rooted at** the junction fails loudly on it; traversals *through* the junction never read it. Substituting one FK would be silently wrong (rows collapse). The emitted model prints the composite key beside it; fixing it needs composite-key support in the package — **#689**. |
| field `type` | `AggColType`: `string→string`, `integer`/`decimal`→`number`, `boolean→boolean`, `uuid→uuid`, `date`/`datetime`→`datetime`, `json→json`, `enum→enum` |
| `string_array`, `entity_ref` | **omitted from `analytics.fields`** — neither has an `AggColType`, and `entity_ref` emits *two* columns from one YAML field. They remain in `registry.columns` (they are real columns); inventing a type would make the package resolve a column it cannot compile. |
| SEM-1 tags | `role` / `agg` / `aggs` / `additivity` / `time` copied verbatim |
| `column` | always emitted explicitly (the snake field name) rather than relying on the package's "defaults to the field key" |
| `choices` / `choices_from` | `hasDeclaredDomain: true` (enum fields). The parser carries `choices_from:` unresolved as `ParsedField.choicesFrom` — the emitter only needs to know the domain is declared, not its values |
| `tenant_id`, `organization_id`, `user_id` | `role: 'dimension'`, never a measure. Measures are only ever what the YAML tags, so "never a measure" holds by construction; the explicit dimension role makes them group-able. |
| behavior columns (`created_at`, `updated_at`, `deleted_at`, `created_by`, `updated_by`) | present in `fields` with their type, no role — they are real columns and must resolve in a filter, but the author did not declare them analytically |
| EAV | `descriptor.eav` left unset (PLAN §5.3 defers it); `eav: true` entities emit normally minus custom fields |

`searchableColumns` replicates the package's rule — string columns that are not identifiers or enums — but derives it
from the **declaration**: `type: string`, not `id` / `external_id`, not `*_id`, not a `belongs_to` FK column, not
`enum`. Per S3 this is also the only stable reading: the introspection form keys off `col.dataType === 'string'`,
which 1.0 changed under it.

### 4. Types: the mirror, and retiring it

The package is not published (charter risk register; query-surface#40). PLAN §5.3's fallback therefore applies:
`types.ts` is emitted as a **verbatim mirror** of the vocabulary — `Agg`, `Additivity`, `AggColType`,
`AggFieldMeta`, `AggRelationship`, `AggEntity`, `AggRegistry`, `RelDescriptor`, `EntityDescriptor` (the subset SEM-2
populates), `AggregateModel`, `MeasureCatalog` and its four def kinds, `DerivedExpr` — the ADR-040 emit-verbatim
precedent.

The emitter names the types module **once**:

```ts
// src/emitters/semantic/emit-model.ts
export const TYPES_MODULE = './types';   // → '@pattern-stack/query-surface' when it publishes
```

A unit test pins that every emitted type import — `model.ts` **and** the `index.ts` barrel's type re-export — is
rendered from `TYPES_MODULE`, so a consumer importing types from the barrel keeps them across the switch.

#### Retiring the mirror (SEM-4) — the complete list, measured

The constant is the start, not the whole change. This list was produced by flipping `TYPES_MODULE` to
`'@pattern-stack/query-surface'` **alone** and running the gates (PR #618 review fix); every item is red until it is
done, except the two marked *not gated*:

| # | Edit | What is red without it |
|---|---|---|
| 1 | `src/emitters/semantic/emit-model.ts` — `TYPES_MODULE = '@pattern-stack/query-surface'` | — (the switch) |
| 2 | `src/emitters/semantic/index.ts` — delete the `if (TYPES_MODULE === './types')` branch, the `buildSemanticTypes` import and re-export, and `SEMANTIC_TYPES_FILE` | `bun run typecheck`: `index.ts(82,6): error TS2367` — the comparison of two distinct literals |
| 3 | Delete `src/emitters/semantic/emit-types.ts` and `src/__tests__/emitters/semantic/conformance.test.ts` | nothing gates it — but the conformance test is red against the package that publishes (below), and a mirror nobody emits is dead code |
| 4 | `src/__tests__/emitters/semantic/emit-model.test.ts` — the `'./types'` pin becomes the package pin; the file-set test becomes `['index.ts', 'model.ts']` | `is the vendored mirror until the package publishes` |
| 5 | Golden — delete `test/semantic-golden/snapshot/types.ts`; regenerate `index.ts` and `model.ts` (`UPDATE_SEMANTIC_GOLDEN=1`) — both change their import specifier | `emits exactly the snapshot file set`, `emits byte-identical content` |
| 6 | `test/smoke/run-smoke.ts` `assertSemanticEmission` — drop `types.ts` from the required-file list | `just test-smoke-relationship`: `[FAIL] semantic model: expected types.ts in src/generated/semantic` |
| 7 | `test/smoke/run-smoke.ts` `RUNTIME_DEPS` — add the pinned `@pattern-stack/query-surface` | once 6 is done, the smoke's `tsc`: `src/generated/semantic/index.ts(18,8)` and `model.ts(13,8): error TS2307: Cannot find module '@pattern-stack/query-surface'` |
| 8 | `package.json` — `@pattern-stack/query-surface` as an **optional peer** (+ `peerDependenciesMeta`) and a **devDependency** | *not gated.* The peer is the consumer contract: a project with `generate.semantic: true` hits item 7's TS2307 without it. The devDependency is what lets SEM-3's fan-out-trap suite resolve the installed package in CI instead of skipping (docs/specs/SEM-3.md) |
| 9 | Docs — `README.md` / `consumer-skills/entities/yaml-reference.md` / the codegen skill: `generate.semantic` needs the package installed; this spec and SEM-3's "what downstream must know" drop the mirror | *not gated* |

The emitted barrel (`emit-index.ts`) needs **no** edit: it re-exports the vocabulary from `TYPES_MODULE`, and every
name it re-exports is exported from the package root (checked against query-surface#41's `src/index.ts`).

**Retiring the mirror is the only exit for the conformance test.** The mirror was written against query-surface
`main` before #41 (17/17 at `61c0df4`). Against #41's head (`ba816c3`) it is 15 pass / 2 fail — the two `has_one`
tripwires — and deleting the tripwire does not make it green: #41 orders the kind union `belongs_to | has_one |
has_many`, the mirror `belongs_to | has_many | has_one`, and unions are compared verbatim. Reordering the mirror would
turn it red against `main` instead. #41 is the change that publishes the package, so the moment the test goes red is
the moment SEM-4 can retire the mirror; the tripwire's message says exactly that.

`EntityDescriptor` is mirrored as a **reduced** interface: the package's carries `eav`, `fieldMeta`, `meta`,
`computed` typed against internal modules SEM-2 does not populate. The mirror declares `meta?: { kind?: 'entity' |
'junction'; summary?: string }` and omits the rest. That is a deliberate narrowing — an emitted model must be
*assignable to* the package's type, not identical to it — and it is what the conformance test checks.

**Conformance test** — `src/__tests__/emitters/semantic/conformance.test.ts`:

- Locates the sibling checkout from `QUERY_SURFACE_PATH`, else a sibling-relative probe. **Absent ⇒ the suite skips
  and prints why**, naming the env var. That is a named, single-purpose skip with a stated reason, not a silent
  filter (I9); it is visible in `just test-all` output.
- Present ⇒ asserts the mirror is a **sound narrowing** of the package's vocabulary, per declaration: a member on
  both sides must have the same type (drift ⇒ fail); a member the package declares and the mirror omits is allowed
  only if it is in a documented `TOLERATED_OMISSIONS` table with a reason; a member the mirror declares and the
  package does not is a failure, with one named exception. Exact equality would be the *wrong* assertion — an
  emitted model must be assignable to the package's types, not identical to them, and demanding identity would force
  the mirror to carry EAV and expression-measure machinery SEM-2 never populates (see Found #2).
- Covers `Agg`, `Additivity`, `AggColType`, `AggFieldMeta`, `AggRelationship`, `AggEntity`, `AggRegistry`,
  `DerivedExpr`, the four `*MeasureDef` kinds, `MeasureDef`, `MeasureCatalog` and `RelDescriptor`.
- `AggregateModel` / `EntityDescriptor` are checked by **member name only**: they reference `PgTable` / `PgColumn`
  and the two checkouts pin different Drizzle majors, so comparing member types would report version skew rather
  than real drift.
- **Named expectation — the `has_one` tripwire:** `AggRelationship.kind` and `RelDescriptor` are expected to differ
  from the mirror in exactly one way — the mirror adds `'has_one'`. The test asserts that difference is present *and*
  sole. When the package gains the kind (query-surface#41) the assertion fails, and its message says the exit is
  retiring the mirror, **not** deleting the expectation — see "Retiring the mirror" above.

### 5. Wiring

- **`entity new` post-step** in `src/cli/commands/entity.ts`, beside the frontend block, gated on
  `generate.semantic === true` (default false, declared by SEM-1). Same **warn-but-don't-fail** contract as the
  frontend emitter — and deliberately *not* REL-1's fail-hard contract: nothing in a generated project imports the
  semantic model, so a failure here does not stop the project compiling. It prints; it does not gate.
- Appears in `--dry-run` plans and in the `--all` path, wherever `regenerateBarrels` runs.
- **`project init`**: nothing. REL-1 must seed an empty `relations.ts` because `database.module.ts` imports it; no
  emitted file imports the semantic model, so an absent directory is correct for a project with no entities. An empty
  entity set skips with a printed reason, like the frontend emitter.

### 6. If query-surface#40 does not land

One line in `build-model.ts` maps `has_one` → `has_many` in both descriptor builders. It is conservative for the
grain oracle — a to-many edge can only make the package *refuse* a sum it would otherwise allow, never allow a wrong
one — and it is a declaration-level lie, so it stays a documented fallback rather than the default.

## Out of scope

- The CRM slice, the fan-out-trap measure, and any live `measure()` execution — **SEM-3** (#592).
- EAV in the model (`descriptor.eav`) — PLAN §5.3.
- Publishing the sibling package, or its `has_one` / Drizzle-1.0 peer work — query-surface#40, operator-owned.
- Consuming the model at runtime (a Nest module, `QueryServiceOptions.aggregateModel` wiring) — not in this project's
  scope; the host injects it.
- Repairing or gating the `clean` pipeline (#602).

## Gates

| Gate | What it proves | Where it runs |
|---|---|---|
| `src/__tests__/emitters/semantic/golden-model.test.ts` | Byte-identical whole-set output for `test/semantic-golden/` — measures with `aggs` and with a single `agg`, a non-additive measure, a time axis, an enum dimension with a declared domain, a `has_one`, a junction, a cross-entity ratio and a derived tree. Regenerate with `UPDATE_SEMANTIC_GOLDEN=1`. Mirrors the frontend golden test. | `just test-unit` → `just test-all` |
| `src/__tests__/emitters/semantic/build-model.test.ts` | Unit: type mapping, `searchableColumns` derivation, junction descriptors + inverse edges, scope columns as dimensions, `through:` omitted, `string_array` / `entity_ref` omitted, registry-resolved plurals, catalog composites only. | `just test-unit` |
| `src/__tests__/emitters/semantic/conformance.test.ts` | The mirror matches the sibling package's vocabulary types, or skips **with a printed reason**. Carries the named `has_one` expectation. | `just test-unit` |
| `just test-smoke-relationship` | **The real gate.** The CRM fixture set gains analytics tags and `generate.semantic: true`, so the emitted `semantic/` tree is type-checked by the smoke's `tsc` over the generated project — under the consumer tsconfig, against the real emitted schema barrel. | `just test-all` |
| `just test-all`, `just test-integration` | No regression in the emitters, CLI or scaffold. | CI |

Extending the existing CRM smoke rather than adding a new one is deliberate: a new smoke is another ~60s of CI for a
narrower claim, and the CRM set is the one SEM-3 builds on.

## What downstream must know

- **Registry keys are entity names** (singular snake); junctions are keyed by their derived junction name. Relationship
  keys are the YAML relationship names verbatim (snake_case). SEM-3's queries and any host wiring must use those.
- **`buildAggregateModel()` is a function, not a const** — it reads `getColumns` at call time, so the module is safe to
  import before the schema is fully initialised.
- **The types module is named once** (`TYPES_MODULE` in `emit-model.ts`), but retiring the mirror is **nine** edits,
  seven of them gated — the measured list is §4 "Retiring the mirror". The emitted barrel re-exports types from
  `TYPES_MODULE`, so it survives the switch untouched.
- **The conformance test is red against query-surface#41** (15/2, the `has_one` tripwires) and green against `main`
  (17/17). Retiring the mirror is its only exit — see §4.
- **`has_one` is emitted but not in the package before #41** (S7).
- **`through:` and EAV are not emitted**, and `string_array` / `entity_ref` are absent from `analytics.fields`.
- **Junction payload columns are emitted** — FKs, `role` (a dimension) when declared with `choices:`, the
  BaseJunctionFields per `temporal` / `sourced`, payload `fields:`, timestamps — and **no `id`**. A junction's
  `primaryKey` / `pk` is `'id'`, which names no column: queries rooted at a junction fail loudly until #689.
- **A junction `role` declared with `values:` generates no column at all** (the template reads `choices:`); every
  junction fixture in the repo uses `values:` — #690. The model mirrors the table, so it has no `role` either.
- **Entity `id` is not in `analytics.fields`** (the entity's `pk`); a junction contributes no `id` either.
- **Soft-deleted rows are summed unless the host's scope excludes them.** The model declares columns, not row
  filters; `deleted_at` is a plain datetime field. Row scoping is the host's `ScopeResolver` (query-surface), per I3.
- **Junction identity (`<a>_<b>`, pluralized) is now derived in three places** — `barrel-generator.ts`,
  REL-1's `build-graph.ts`, and here — because REL-1 and SEM-2 are sibling PRs that cannot import each other.
  Consolidating is a follow-up for after both land, not a thing either PR can do alone.

## Found during implementation

### Found #1 — a junction's table const is camelCased; an entity's is not

The design said table identifiers are `entity.plural` verbatim, citing REL-1. That is true for entities and **false
for junctions**. `templates/entity/new/clean-lite-ps/entity.ejs.t:32` emits `export const <plural> = pgTable(…)` —
`deal_states`, snake — while `templates/junction/new/entity.ejs.t:41` emits `export const <tableVarName>` where
`tableVarName = camelCase(plural)` — `opportunityContacts`. The first draft emitted
`schema.opportunity_contacts`, which does not exist. The golden snapshot surfaced it on its first generation;
`junctionIdentity` now returns a separate `tableVar` and the divergence is documented at the call site, because the
next emitter to reach for a table identifier will hit exactly this.

### Found #2 — "verbatim mirror" had to become "sound narrowing", and that is a better test

The design said the conformance test asserts the mirrored types are *declaration-identical*. Two declarations make
that impossible, and both are correct as they stand:

- `AggFieldMeta.eav` — an EAV resolution descriptor. SEM-2 does not populate EAV (PLAN §5.3).
- `AtomicMeasureDef.on: string | RowExpr` and `.where?: Predicate` — `RowExpr` / `Predicate` are package-internal
  types the mirror cannot reference, and SEM-2 emits **no** atomic entries at all (the package derives them).

Demanding identity would have forced the mirror to carry machinery the emitter never uses. The test now asserts the
property that actually matters — *every member declared on both sides has the same type; every omission is in a
documented table with a reason; every addition is a failure except the named `has_one` expectation*. Verified it
still bites: widening `additivity` to `Additivity | 'sometimes'` in the mirror fails with
`AggFieldMeta.additivity drifted from the package`.

### Found #3 — the smoke's `tsc` really does gate the emitted model (measured, not assumed)

The claim "the emitted tree is type-checked by the smoke" was verified rather than asserted, in the spirit of
GATE-1/GATE-2. Emitting `primaryKey: 42` instead of a string made `just test-smoke-relationship` fail with
`src/generated/semantic/model.ts(42,3): error TS2322: Type 'number' is not assignable to type 'string'` and exit 1.
A second probe (`schema.<plural>NoSuchTable`) was caught earlier, by the smoke's own assertions. Both probes were
reverted.

### Found #5 — review fix (PR #618): the recipe, the barrel, `choices_from`, junction columns

The retroactive review (REVISE) found the retirement recipe wrong: it named a `SEMANTIC_FILES` constant that never
existed and missed six of the edits. §4 now carries the list **measured** by flipping the constant alone (typecheck
TS2367; 3 unit failures; the smoke's file assertion; then the smoke's TS2307 ×2). Three code defects were fixed
rather than documented:

- **The barrel would have dropped the types on the switch.** `emit-index.ts` re-exported them only when
  `TYPES_MODULE === './types'`; it now re-exports from `TYPES_MODULE`, so consumers importing types from the barrel
  keep them.
- **`choices_from` enums lost their declared domain.** The parser did not carry `choices_from`; it now does
  (`ParsedField.choicesFrom`), and `hasDeclaredDomain` reads it.
- **Junction columns.** The junction block emitted `id` plus the two FKs. The `id` was a phantom — junctions have a
  composite key and no `id` column — and every real payload column was missing. The block now mirrors the junction
  template's column set exactly (§3). Two defects it exposed are filed rather than fixed here: the composite key the
  package cannot express (#689), and junction fixtures whose `role: { values: … }` generates no column (#690). The
  golden junction now declares `role` with `choices:` and a decimal payload field so the snapshot locks both paths.

### Found #4 — the conformance test skips by default in this repo's own CI

`QUERY_SURFACE_PATH` is unset and the sibling is not laid out beside this checkout, so `just test-all` runs the suite
as 17 skips plus the printed reason. That is deliberate — a machine-specific absolute path does not belong in the
repo — but it means the mirror's agreement with the package is a **local** gate until the package publishes and the
mirror disappears. What still gates in CI: the golden snapshot pins the mirror's text, and the smoke's `tsc` pins
that the emitted model compiles against it. Recorded here rather than papered over.

## Gate results

Run after the last code edit, on `dugshub/591-semantic-model-emitter`:

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | clean / clean / all tests passed |
| `just test-all` | **exit 0** — 3307 pass / 17 skip / 0 fail across 206 files; every smoke PASS |
| `just test-integration` | **exit 0** — 64 pass / 2 skip / 0 fail |
| `just test-smoke-relationship` (the emitter's real gate) | **exit 0**; `semantic model regenerated (3 files) → src/generated/semantic`, `semantic emission OK`, `tsc OK` |

The 17 skips are the conformance suite (Found #4), which prints its reason. With `QUERY_SURFACE_PATH` pointing at
query-surface `main` (`61c0df4`) it is 17 pass / 0 fail; at query-surface#41's head (`ba816c3`) it is 15 pass / 2 fail
— the `has_one` tripwires, whose only exit is retiring the mirror (§4). An earlier revision of this table claimed
17/17 against a `query-surface-40` checkout; that was a pre-#41 head.
