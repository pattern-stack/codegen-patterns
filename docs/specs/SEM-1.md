# SEM-1 — analytics vocabulary → field tags (role / agg / aggs / additivity / time) + catalog metrics

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #590 · **Epic:** #581 · **Project:** #578
**Depends on:** DRZ-2 (#584) · **Blocks:** SEM-2 (#591), SEM-3 (#592)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5.1–5.2, §5.5

## Why

The entity YAML carries a MetricFlow-shaped `analytics:` vocabulary that **nothing consumes**. Unit 3 emits a
*declared* `AggregateModel` for the sibling semantic-query package (`@pattern-stack/query-surface`), whose field-tag
vocabulary is a different, smaller shape. Under charter I7 the old vocabulary is **replaced**, not extended: no
aliases, no deprecation window, no parallel schemas.

SEM-1 is the schema + parser half only. No emitter — that is SEM-2.

## Charter invariants this PR touches

- **I7 no backwards compat.** Every removed key is removed, not aliased. The field schema becomes `.strict()` so a
  YAML still carrying a removed key fails loudly by name instead of being silently stripped (see §3).
- **I1 declare once.** The measure **catalog key** derivation (`field` vs `field.agg`) is the package's own rule,
  applied here to the declared tags so a metric leg can be resolved at parse time. SEM-2 must therefore **not** emit
  atomic catalog entries — the package derives them (`measuresFromRegistry`). One rule, one emitter of the result.
- **I9 honest gates.** No new `any`. Full gate list in §Acceptance, reported from the run after the last edit.
- **I10 public repo.** The sibling package is named; no host application, consumer or product detail appears here.
- **I11 scope discipline.** Schema, parser and config only; no template, no `clean` pipeline work.

## Verified state — the old vocabulary is parse-only

Measured on this branch (`dugshub/590-analytics-vocabulary`, base `dugshub/604-list-default-sort`):

| Claim | Evidence |
|---|---|
| Nothing outside `src/schema/entity-definition.schema.ts` reads a field-level analytics key | `grep -rn` for `analytics_aggregation` / `non_additive_dimension` / `dimension_type` / `time_granularity` / `is_partition` / `entity_role` / `semantic_expr` / `semantic_label` / `analytics_visibility` / `agg_time_dimension` over the whole repo: hits are the schema itself, `runtime/analytics/{types,specs}.ts` (the cube-side mirror, §4), and plan docs. No template, emitter, parser or test. |
| Nothing reads the entity-level block | `measure_packs` / `cube_name` / `AnalyticsBlockSchema`: schema only. `ParsedEntity` has no `analytics` field, so the block is parsed and discarded. |
| No fixture or example declares `analytics:` | 61 YAML definition files under `test/`, `examples/`, `packages/` scanned for field keys outside the declared set — the only unknown key is `values:` on **junction** fixtures, which parse against `JunctionDefinitionSchema`, not `FieldDefinitionSchema`. Zero `analytics:` blocks. |
| `generate.analytics: none \| cube` gates nothing | Only reader is the Zod default in `src/schema/codegen-config.schema.ts:60`. No template, scanner or scaffold writes or reads it. |
| No cube emitter exists | No `templates/subsystem/analytics/`, no entry in `src/cli/commands/subsystem.ts`'s scaffold map, nothing in `init-scaffold.ts`. |

So the vocabulary can be replaced wholesale with no shim.

## Target vocabulary — confirmed against the sibling package

Read from the checkout at `/root/wt/sdlc-patterns/query-surface`
(`src/internal/analytics/types.ts`, `src/internal/analytics/measure-catalog.ts`,
`src/adapters/drizzle/registry/model.ts`). Nothing is copied; the YAML is designed to *produce* these shapes.

**Field tags** (`AggFieldMeta`):

```
type: 'number'|'string'|'boolean'|'datetime'|'json'|'uuid'|'enum'   // derived at emit time (SEM-2)
role?: 'measure' | 'dimension'
agg?:  'count'|'count_distinct'|'sum'|'avg'|'min'|'max'
aggs?: Agg[]
additivity?: 'additive'|'semi'|'non'
time?: boolean
column?: string             // derived at emit time (SEM-2)
hasDeclaredDomain?: boolean // derived at emit time from choices / pg-enum (SEM-2)
eav?: {...}                 // out of scope (PLAN §5.3)
```

`type`, `column` and `hasDeclaredDomain` are **derivable from what the YAML already declares** (`type:`, the naming
config, `choices` / `choices_from`) and are therefore *not* YAML keys — declaring them would be a second declaration
(I1). SEM-1 declares only `role` / `agg` / `aggs` / `additivity` / `time`.

**Catalog composites** (`MeasureCatalog`): `RatioMeasureDef { numerator, denominator, label? }`,
`DerivedMeasureDef { expr, label? }` where `expr` is the closed tree `{ref}|{lit}|{op:'+'|'-'|'*'|'/',left,right}`,
`CumulativeMeasureDef { measure, order_by, partition_by?, label? }`. Atomic entries are **derived** by the package
from the field tags (`measuresFromRegistry`), never authored.

**Why `additivity` is required on a measure.** `measuresFromRegistry` skips a `role: 'measure'` field that carries no
`additivity` — it silently does not become a measure. And `validateMeasureDef` enforces "a def may tighten additivity
but never loosen it" against the *field's* value, so the field must carry the truth. Additivity is not inferable from
`type: decimal`. Hence: required, per field (charter PLAN §5.5, answering "per measure, per pack, or both?").

## Scope

### 1. Field-level schema (`src/schema/entity-definition.schema.ts`)

`SemanticMetadataSchema` → `AnalyticsFieldSchema`:

```yaml
fields:
  amount:
    type: decimal
    role: measure
    aggs: [sum, avg, min, max]
    additivity: additive
  win_probability:
    type: decimal
    role: measure
    agg: avg
    additivity: non
  stage:
    type: enum
    choices: [prospecting, negotiation, closed_won]
    role: dimension
  closed_at:
    type: datetime
    role: dimension
    time: true
```

Removed with no replacement: `measure`, `analytics_aggregation`, `agg_time_dimension`, `non_additive_dimension`,
`dimension`, `dimension_type`, `time_granularity`, `is_partition`, `entity`, `entity_type`, `entity_role`,
`analytics_visibility`, `semantic_expr`, `semantic_label`. Keys/roles come from `relationships:` (and from `roles:`
once CAP-2 lands); label/visibility already ride `ui_label` / `ui_visible` (ADR-040).

`AnalyticsAggregationSchema` (9 values) → `AggSchema` = `count | count_distinct | sum | avg | min | max`.
`average` becomes `avg`; `median`, `percentile` and `sum_boolean` are dropped — the package's `Agg` has no equivalent
and emitting one would produce a model it refuses.

**Field-level validation** (Zod refinements on `FieldDefinitionSchema`, alongside the existing
`required`/`nullable` rules):

| # | Rule | Message anchor |
|---|---|---|
| F1 | `role: measure` requires `agg` **or** `aggs` | `path: ['agg']` |
| F2 | `role: measure` requires `additivity` | `path: ['additivity']` |
| F3 | `agg` and `aggs` are mutually exclusive | `path: ['aggs']` — the package's `meta.aggs ?? [meta.agg]` would silently drop `agg`, and the catalog key shape differs between the two (`field` vs `field.agg`), so accepting both would make the key ambiguous |
| F4 | `aggs` must be non-empty and free of duplicates | `path: ['aggs']` |
| F5 | `agg` / `aggs` / `additivity` require `role: measure` | `path: [<the key>]` — dangling aggregation config on a dimension is an author error |
| F6 | `time: true` requires `type: date` or `type: datetime` | `path: ['time']` — the repo's only temporal field types |
| F7 | `time: true` is incompatible with `role: measure` | `path: ['time']` — `time` marks the axis a semi-additive measure may not be summed across; a measure is not that axis |

`FieldDefinitionSchema` gains `.strict()` (applied to the merged object, before the refinement chain). Without it a
YAML carrying `measure: true` parses to `{}` and the author never learns the key is gone — the opposite of a loud
replacement. Verified safe: no entity YAML in the repo uses a key outside the declared set.

### 2. Entity-level schema — `analytics.metrics:`

`AnalyticsBlockSchema` drops `measure_packs` and `cube_name` and keeps only `metrics:`, retyped to the three
composite kinds. The `simple` metric type disappears: a simple metric **is** a measure-tagged field.

```yaml
analytics:
  metrics:
    win_rate:
      type: ratio
      numerator: won_amount.sum
      denominator: amount.sum
      label: Win rate
    gross_profit:
      type: derived
      expr:
        op: '-'
        left:  { ref: revenue.sum }
        right: { ref: cost.sum }
    running_pipeline:
      type: cumulative
      measure: amount.sum
      order_by: created_at
      partition_by: account_id
```

`expr` is a **tree**, not a string (PLAN §5.2 recommendation, adopted): it is exactly what the package validates and
lowers, so a string form would mean writing and maintaining a parser whose only job is to produce this tree.
`DerivedExprSchema` is a `z.lazy` recursive union of `{ ref: string }`, `{ lit: number }` (finite) and
`{ op: '+'|'-'|'*'|'/', left, right }`.

Dropped from the metric shapes: `filter`, `description`, `window`, `grain_to_date`. The package's defs carry only
`label?` beyond their structural fields; a key with no consumer is a third place to declare intent.

**Entity-level structural validation** (Zod, per file — no cross-entity knowledge):

| # | Rule |
|---|---|
| E1 | a `derived` `expr` must reference at least one `{ref}` (a pure-literal metric is meaningless) |
| E2 | `{lit}` must be a finite number; `op` must be one of `+ - * /`; `left` and `right` are both required |

Leg **resolution** is cross-entity and lives in §4.

The `analytics:` block is an *authoring home*, not a scope: `MeasureCatalog` is one flat `Record<name, MeasureDef>`,
so a metric declared on `opportunity` may name legs on `account`. That is why name uniqueness (C3/C4 below) is a
cross-entity rule.

### 3. Parser (`src/parser/load-entities.ts`, `src/analyzer/types.ts`)

- `parseAnalyticsMetadata(fieldDef)` mirroring the existing `parseUiMetadata` exactly (same file, same shape, called
  from both the entity and relationship-definition field parsers so the two cannot drift) → `ParsedField.analytics`:
  `{ role?, agg?, aggs?, additivity?, time? }`.
- `ParsedEntity.analytics?: { metrics?: Record<string, ParsedMetric> }`, carrying the block through verbatim.
- New exported types on `src/analyzer/types.ts`: `ParsedFieldAnalytics`, `ParsedMetric` (the discriminated union),
  `DerivedExpr`.

`ParsedField.analytics` is optional-per-key rather than `undefined` when empty, matching `ParsedField.ui`'s
always-present-object convention — SEM-2's emitter then reads one shape.

### 4. Cross-entity validation (`src/parser/validate-semantic.ts`, new)

Mirrors `src/parser/validate-emits.ts` (EVT-7): a pure function over `ParsedEntity[]` returning `AnalysisIssue[]`,
never throwing.

```ts
export function validateSemanticModel(
  allEntities: ParsedEntity[],
  targets: ParsedEntity[] = allEntities,
): AnalysisIssue[]
```

**Atomic catalog keys** are derived by the package's own rule (`measuresFromRegistry`), replicated here so a leg can
be resolved before emission:

- a `role: measure` field declaring `aggs` yields one key per agg: `<field>.<agg>` (e.g. `amount.sum`, `amount.avg`);
- a `role: measure` field declaring `agg` yields the bare key `<field>`.

| # | Rule | Severity |
|---|---|---|
| C1 | an atomic key owned by two entities is ambiguous | error — the package throws on exactly this at model load |
| C2 | every `ratio` leg, `derived` `{ref}` and `cumulative` `measure` must name a declared atomic key | error, message lists the nearest declared keys |
| C3 | metric names are unique across all entities | error — one flat catalog namespace |
| C4 | a metric name may not collide with a derived atomic key | error — same namespace |
| C5 | `cumulative.order_by` / `partition_by` must be declared fields **on the entity that owns the accumulated measure** | error — that is the entity the window runs over |

Wired in two places, following the `validateEntityEmits` precedent exactly:

- `src/index.ts` `analyzeDomain()`, next to `resolveReferences()` — so `just validate-entities` / `just analyze`
  report it;
- `src/cli/commands/entity.ts` pre-flight, next to the `emits:` block — so `entity new` **fails** on an unresolvable
  leg (honouring `--no-continue-on-error` the same way).

Both call sites already hold the full entity set, so no extra load.

### 5. Config (`src/schema/codegen-config.schema.ts`)

`generate.analytics: z.enum(['none','cube']).default('none')` → `generate.semantic: z.boolean().default(false)`,
mirroring `generate.frontend` (the ADR-038 single-gate precedent). SEM-2 gates its emitter on it; SEM-1 only declares
it, and the doc comment says so rather than describing an emitter that does not exist yet.

### 6. The cube runtime island

`@cubejs-client/core` is an optional peer solely for `runtime/subsystems/analytics/cube-backend.ts`. Dropping the peer
(issue scope) while keeping a lazy `import('@cubejs-client/core')` would ship a runtime path whose dependency the
package no longer declares. The whole island goes:

- `runtime/analytics/**` — `types.ts` / `specs.ts` / `metrics.ts` / `packs/{crm-entity-measures,monetary-measures}.ts`.
  Its own header states its purpose: *"the intermediate representation used when extracting semantic metadata from
  entity YAML and converting it into cube.js schema"* — the runtime half of the vocabulary being replaced. It is the
  only definition of the `measure_packs` referents (`crm_entity`, `monetary`).
- `runtime/subsystems/analytics/**` — `IAnalyticsQuery`, tokens, module, cube + noop backends.
- `src/__tests__/runtime/subsystems/analytics.spec.ts`.
- `@cubejs-client/core` from `peerDependencies`, `peerDependenciesMeta` and `devDependencies`.

Verified reachable from nowhere else: not exported from `runtime/subsystems/index.ts`, not in the `subsystem` CLI's
scaffold map, no `templates/subsystem/analytics/`, no `init-scaffold` entry, and no import outside the island itself.

**Kept:** `runtime/base-classes/with-analytics.ts` and its spec. The `WithAnalytics` mixin adds an `analytics?: any`
provider slot to every generated service (`templates/entity/new/clean-lite-ps/service.ejs.t:8`, the relationship and
junction service templates, and both junction snapshots). It has no dependency on either deleted tree.

**Correction to PLAN §5.5:** "Packs have no definition anywhere in the repo; delete the key" is wrong — the packs are
defined in `runtime/analytics/packs/`. The conclusion is unchanged (delete the key), but the reason is that packs are
a cube-era indirection, not that they were undefined. PLAN is corrected in this PR.

### 7. Documentation

- `consumer-skills/entities/yaml-reference.md` — new `analytics:` / field-tag section. The file is the "full field
  reference" the codegen skill points at and today documents none of this vocabulary.
- `.claude/skills/codegen/SKILL.md:176,204` — the two lines that describe `analytics: { ... }  # cube
  measures/metrics (generate.analytics: cube)` and `analytics: none  # none | cube`.
- `README.md` §Configuration — `generate.semantic` in the `codegen.config.yaml` block.
- `docs/adrs/ADR-045-semantic-model-vocabulary.md` (new) — the durable decision: replace not extend, per-field
  additivity, declared-not-introspected, Q4's catalog home. SEM-2 appends its emitter decisions as a dated revision
  note rather than minting a second ADR (PLAN §8 mints ADR-045 for SEM-1/2 jointly).
- `.ai-docs/.../PLAN.md` §5.2 and §5.5 corrected to what was built.

**Not updated:** `src/schema/generate-json-schema.ts`. It is a hand-written editor-autocomplete subset that already
omits `analytics:`, `queries:`, `events:`, `integration:` and `patterns:`. Adding one block to a mirror that is
incomplete by construction buys nothing; it is pre-existing I1 drift, tracked separately from this issue.

## Non-goals

- Any emitter (`AggregateModel`, `model.ts`, `catalog`) — SEM-2 (#591).
- Any fixture carrying the new tags — SEM-3 (#592) owns the demonstration fixture and its gates.
- EAV field tags (`AggFieldMeta.eav`) — PLAN §5.3 defers them.
- `runtime/base-classes/with-analytics.ts` — an unrelated DI slot that happens to share the word.
- The `clean` backend pipeline (#602, charter I11).

## Decisions recorded here

**Q4 (charter §7) — where does the metric catalog live: YAML or the consuming adapter?**
**Decided by default, per the charter's own recommendation: YAML for atomic tags and for composites that are pure
functions of declared fields** (`ratio` / `derived` / `cumulative` over named measures); **the consuming adapter for
anything data-driven** (value domains harvested from live data, EAV overlays). The emitted catalog is therefore a
complete, static artifact, and an adapter's own `catalog` merges additively on top of it. This is what SEM-1 builds;
**flagged for owner confirmation** — reversing it later means moving the composite metric schema out of the entity
YAML, which is a schema change, not a re-plan.

**Additivity granularity — per field.** See §Target vocabulary. `measure_packs` is deleted rather than retyped.

## Acceptance

Unit tests (`src/__tests__/schema/analytics-vocabulary.test.ts`,
`src/__tests__/parser/validate-semantic.test.ts`) covering **every** rule F1–F7, E1–E2 and C1–C5, each with a passing
and a failing case, plus:

- a removed key (`measure: true`) is rejected by name, not stripped;
- `parseAnalyticsMetadata` round-trips a fully-tagged field onto `ParsedField.analytics`;
- the atomic-key derivation produces `amount.sum` / `amount.avg` for `aggs:` and bare `amount` for `agg:`.

Gates (charter §7, output reported from the run after the last edit):

- `bun run typecheck && bun run build && bun run test`
- `just test-all` (typecheck + unit + baseline + 6 smokes + junction + integration-emit)
- `just test-integration`
- `just test-smoke` — required independently because §6 deletes files under `runtime/`; `bun run typecheck` does not
  validate the vendored runtime under the stricter consumer tsconfig (charter I9).

## What downstream must know

- **SEM-2 must not emit atomic catalog entries.** The package derives them from the field tags
  (`measuresFromRegistry`); emitting them too would be a second declaration and would trip the package's own
  ambiguity check. SEM-2 emits `analytics` (the field tags), `registry`, `tables`, `colByDbName`, and the **composite**
  half of `catalog` only.
- **The atomic key shape is `field.agg` when `aggs:` is declared and bare `field` when `agg:` is.** Metric legs,
  `{ref}`s and any SEM-3 fixture must use that spelling. `src/parser/validate-semantic.ts` exports the derivation.
- **`type` / `column` / `hasDeclaredDomain` are SEM-2's to derive**, not YAML keys — from `type:`, the naming config,
  and `choices` / `choices_from` / pg-enum respectively.
- **Temporal means `date | datetime`.** If a `timestamp` field type is ever added, F6 must learn it.
- **`generate.semantic` exists and defaults to `false`.** SEM-2 gates on it; nothing reads it yet.
- **The cube island is gone**, including the `@cubejs-client/core` peer. `WithAnalytics` stays.

## Found during implementation

**Found #1 — E1 cannot live on the metric.** The design put the "a derived expression must reference at least one
measure" rule on `DerivedMetricSchema`. Zod 3's `z.discriminatedUnion` rejects a refined member: a `.refine()` returns
a `ZodEffects`, not a `ZodObject`, and the union's option type demands the latter (TS2345 at
`entity-definition.schema.ts`). The rule moved to a `superRefine` on `AnalyticsBlockSchema`, which is strictly better
anyway — the metric **name** is only in scope there, so the message says *which* metric is malformed instead of
pointing at an anonymous `expr`. Any later rule spanning a metric's shape belongs at the same level.

**Found #2 — collision rules are target-aware.** C1/C3/C4 are whole-model defects, but reporting every collision in a
domain would make `codegen entity new <one-entity>` refuse over an unrelated pair. `validateSemanticModel` now reports
a namespace collision only when at least one side is in `targets`. With the default `targets = allEntities`
(`analyzeDomain`, hence `entity validate`) nothing is filtered — this is a blast-radius rule for the generate path,
not a relaxed gate.

**Found #3 — `ParsedField.analytics` is required, not optional.** Making it optional would have every consumer write
`field.analytics?.role`. It is a required property holding an all-optional object, exactly like `ParsedField.ui`. The
cost is one line per `ParsedField` construction site (there are two, both in `load-entities.ts`); the compiler names
both.

**Found #4 — `validateSemanticModel` is wired to the JSON-mode contract of the `emits:` pre-flight, including its
quirk.** `entity new`'s existing `emits:` gate only returns non-zero inside an `if (!isJsonMode())` branch, so in
`--json` mode an error is neither printed nor fatal. The semantic pre-flight mirrors that block exactly rather than
diverging in the same function; fixing the JSON path is a change to both gates and belongs in its own issue, not
smuggled in here.

**Found #5 — PLAN §5.5's premise about measure packs was wrong, and packs had real referents.** See §6 above. The
conclusion (delete the key) is unchanged; PLAN is corrected in this PR.

**Found #6 — nothing in the field schema was strict before.** `FieldDefinitionSchema` stripped unknown keys silently
while `EntityDefinitionSchema` and `RelationshipSchema` were already `.strict()`. Measured across 61 YAML definition
files before changing it: the only unknown field key anywhere is `values:` in junction fixtures, which parse against
`JunctionDefinitionSchema`. The strictness landed with no fixture change.

**Not found, worth recording:** `src/schema/generate-json-schema.ts` holds a second, hand-written
`FieldDefinitionSchema` for editor autocomplete. It never mirrored the analytics keys (nor `queries:`, `events:`,
`integration:`, `patterns:`), so this PR had nothing to update there. It is pre-existing I1 drift; a later unit adding
a field key will hit the same fork in the road.

## Gate results

Run after the last code edit, on `dugshub/590-analytics-vocabulary`:

| Gate | Result |
|---|---|
| `bun run typecheck` | clean |
| `bun run build` | clean |
| `bun run test` (baseline generate + compare) | all tests passed |
| `just test-all` | **exit 0** — the whole chain: typecheck, 3236 unit tests pass / 0 fail across 201 files, baseline, then `smoke PASS` (×2 — `test-smoke` and `test-smoke-relationship`), `subsystems smoke PASS (vendored + package)`, `smoke-junction PASS` (junction + junction-cross-domain), `test-junction`, `test-integration-emit`, `smoke-integration PASS` |
| `just test-integration` | **exit 0** — 64 pass / 0 fail / 2 skipped, 66 tests across 7 files |

Two environmental flakes were hit and diagnosed rather than ignored, because under charter I9 an unexplained red is
not a pass. Both come from harnesses sharing fixed global names with every other checkout on the machine:

- **Shared `bunx` cache.** Three `just test-all` runs failed one rotating test each in
  `src/__tests__/cli/subsystem*.test.ts`, always with `ENOENT reading "/tmp/bunx-0-hygen@latest/…"` or
  `Cannot find module './ops'` — a different file each run. The CLI shells out to `bunx hygen`, whose cache lives at a
  fixed `$TMPDIR` path shared by every checkout; a concurrent run repopulating it produces exactly this. Each failing
  file passes in isolation, and re-running with a private `TMPDIR` is green.
- **Shared Docker Compose project.** `test/scaffold/docker-compose.yml` has no `name:`, so the project name derives
  from the directory (`scaffold`) and is identical in every worktree. Three distinct symptoms, one cause: a
  `drizzle-kit push` failing with `missing_hints: 15 unresolved decisions` over a half-created schema; a
  `network scaffold_default not found` while starting; and a run where 57 of 66 tests died with
  `Connection terminated unexpectedly` because a sibling's `docker compose down -v` removed the container mid-run. The
  same command on the **base commit** (`cd5d16d`, in a scratch worktree) was run to check and passed, and setting
  `COMPOSE_PROJECT_NAME` to something unique makes this branch green.

Neither is caused by this change — the diff touches no template, no scaffold, no Hygen call and no schema emission —
but both are real: **when another checkout on the box may be running gates, run them with a private `TMPDIR` and a
unique `COMPOSE_PROJECT_NAME`.** Giving the compose file a `name:` derived from the checkout would fix the second one
at the source; that is a harness change, out of this issue's scope, and is called out in the PR rather than done here.
