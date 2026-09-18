# SEM-3 — the CRM vertical slice: the emitted model answers a fan-out-trap measure

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #592 · **Epic:** #581 · **Project:** #578
**Depends on:** SEM-2 (#591) · **Companion:** pattern-stack/query-surface#40
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5.4 · ADR-045

## Why

SEM-1 declared the vocabulary and SEM-2 emitted the model. Neither proves the model is **correct** — only that it
parses, that its text is stable, and that it compiles. The charter's exit criterion for this epic is sharper than
that: *"CRM slice answers a fan-out-trap measure correctly."*

The fan-out trap is the reason a semantic layer exists at all. Sum a child's money column over a `has_many`, group at
the parent's grain, and ask for anything else about the parent in the same query, and a naive single-pass join
double-counts the parent — once per child row. SEM-3 builds a slice that contains the trap and shows the emitted
model walking out of it.

## Charter invariants this PR touches

- **I9 honest gates.** The demonstration is a real query against real Postgres, asserted against real rows — and the
  counter-example (what a naive join returns) is asserted too, so the test proves the trap exists rather than
  assuming it. Where the gate cannot run it **skips with a printed reason**: a named, single-purpose skip, never a
  filter. No new `any`.
- **I2 generated means regenerated.** The integration test executes the **checked-in emitted artifact**
  (`test/semantic-golden/snapshot/model.ts`), not a hand-written stand-in. If the emitter regresses, the snapshot
  changes and the demonstration runs against the changed file.
- **I7 no backwards compat.** Fixture tags are edited in place; the golden snapshot regenerates.
- **I10 public repo.** The slice is a generic CRM shape — accounts, contacts, opportunities. No host application
  detail.
- **I11 scope discipline.** `clean-lite-ps`; the `clean` pipeline stays known-red (#602).

## Verified before designing — the sibling package runs on Drizzle 1.0

The open question this spec had to answer was whether the demonstration could be **automated** or had to be recorded
as a manual gate. It can be automated. Measured 2026-09-17, probing **from inside this repo** so `drizzle-orm`
resolves to 1.0.0-rc.4 (charter §8); probe deleted after measuring.

| # | Claim | Evidence |
|---|---|---|
| T1 | **query-surface#40 has still not started.** Both checkouts (`query-surface`, `query-surface-40`) sit at `61c0df4`, `origin/main`'s tip. The package is `private: true`, `version 0.1.0`, peer `drizzle-orm ^0.45.2`, and `grep -rn has_one src/` is empty. | `git log --oneline -3` in both; its `package.json`. |
| T2 | `Relations`, `relations`, `createMany`, `createOne` are **absent** from 1.0.0-rc.4's root export; `getTableColumns`, `getColumns` and `defineRelations` are present. | Probe enumerating the root export. |
| T3 | The package's **introspection** path value-imports those removed APIs (`registry/introspect.ts:12`, `registry/schema-registry.ts:16`), so it cannot run on 1.0 — which is what #40 is for. | Its source. |
| T4 | **The package's public barrel imports cleanly under 1.0.0-rc.4 anyway** (39 exports), because `src/index.ts` does not transitively reach those two modules. | `await import('<checkout>/src/index.ts')` from inside this repo → `IMPORT OK — exports: 39`. |
| T5 | **The engine runs against a host-supplied model on 1.0**, executing real SQL against real Postgres. | `runAggregateDrizzle(db, model, input)` returned `select "accounts"."name", sum("opportunities"."amount") … group by "accounts"."name"` and the correct rows. |
| T6 | `measuresFromRegistry(model.analytics)` over the **emitted** analytics yields exactly `['amount.sum', 'amount.avg']` — SEM-2's promise that the package derives the atomic catalog from the field tags, confirmed against the real function. | Probe. |
| T7 | `needsCte` is `true` when **measures span more than one source entity**, not merely when one measure crosses a `has_many`. A single cross-`has_many` measure plans `needsCte: false, rootJoinWouldFan: true`. | `grain.ts:93` (`needsCte: sources.length > 1`) and both probe runs. |
| T8 | A `has_one` edge in the emitted model does not disturb the engine: the graph walks match on `kind === 'belongs_to' / 'has_many'` and ignore an unknown kind. | `join-plan.ts` `belongsToPaths` / `directHasMany` / `reachableAny`; the probe's model carried `has_one` throughout. |
| T9 | `diagnoseAggregate(reg, q)` takes the **`AggRegistry`**, not the whole `AggregateModel`; `conformedDimensions(reg, entity)` likewise. The Nest `QueryApplicationService` needs `(db, options)` with a required `scope`, plus presentation-layer wiring this slice does not have. | `internal/analytics/doctor.ts:22`, `join-plan.ts:249`, `query.application-service.ts:210-222`. |

### What T7 means for the acceptance criterion

The issue asks for *"one `measure` that sums over a `has_many` grouped at the parent grain"* asserting *"correct rows
and `needsCte: true`"*. Those are two requests and the single-measure form satisfies only the first. The shape that
satisfies **both** — and is the one that actually demonstrates the trap — adds a second measure on the parent:

```
entity: account, group_by: ['account.name'], measures: [
  { on: 'amount', agg: 'sum',   source: 'opportunity', as: 'pipeline' },   // over the has_many
  { on: '*',      agg: 'count', source: 'account',     as: 'accounts'  },  // at the parent grain
]
```

Measured: `plan = { groupGrain: 'account', needsCte: true, rootJoinWouldFan: true, sources: ['opportunity','account'] }`,
rows `Acme → pipeline 350, accounts 1`. The equivalent naive single-pass join returns `Acme → pipeline 350,
accounts 2` — Acme has two opportunities, so the parent is counted once per child row. **That contrast is the test.**

## Scope

### 1. The slice — CRM fixtures gain the four tags the issue names

`test/smoke/fixtures/crm/` (the `test-smoke-relationship` set) and `test/semantic-golden/entities/` are edited in
step, so the snapshot locks exactly what the smoke compiles:

| Requirement | Where |
|---|---|
| additive money measure with `aggs: [sum, avg, min, max]` | `opportunity.amount` — widened from SEM-2's `[sum, avg]` |
| non-additive **percentage** | `opportunity.win_probability` — `role: measure`, `agg: avg`, `additivity: non` |
| `time: true` axis | `opportunity.closed_at` (already tagged by SEM-2) |
| one `ratio` in `metrics:` | `win_rate = won_amount.sum / amount.sum` (already declared by SEM-2) |
| junction shapes | `test/semantic-golden/junctions/opportunity_contact.yaml`, aligned with the canonical `test/fixtures/junctions/opportunity_contact.yaml` (temporal, sourced, the five-value `role` enum) |

**The junction is exercised in the golden suite and the integration test, not in the smoke.** Adding junction
generation to `run-smoke.ts` means wiring a `junction new` pass into a file REL-1 (#614) is also editing, for a claim
the golden snapshot and the live query already make at the level that matters — the emitted model. The junction
smokes (`test-smoke-junction`, `-cross-domain`) already prove junction *code* compiles.

### 2. The golden suite gains a schema, so the snapshot is executable

SEM-2's `test/semantic-golden/snapshot/model.ts` imports `../schema` — the generated barrel — which does not exist in
the fixture tree, so the snapshot could be diffed but never run. SEM-3 adds **`test/semantic-golden/schema.ts`**: a
hand-written Drizzle module declaring the four fixture tables, standing in for the generated barrel.

It is hand-written on purpose and labelled as such. Generating it would mean running the whole entity pipeline inside
a unit test; the smoke already proves the emitter agrees with the real generated barrel (it type-checks against it).
What this file buys is that the **checked-in emitted model becomes importable**, so the integration test executes the
real artifact rather than a paraphrase of it. A focused assertion pins that every table the snapshot references
exists here, so the two cannot drift apart silently.

### 3. The demonstration gate

`test/integration/semantic-fanout.drizzle.integration.test.ts`, following the established
`test/integration/*.drizzle.integration.test.ts` pattern (own ephemeral `postgres:16` via testcontainers —
self-contained, so it cannot collide with a sibling checkout's scaffold database).

It imports `buildAggregateModel()` from the emitted snapshot and, through the package's public exports:

1. **describe** — `conformedDimensions(model.analytics, 'opportunity')` returns the local dimensions **and** the
   to-one reach `account.name` with `via: 'to-one'`, derived entirely from what SEM-2 emitted;
   `measuresFromRegistry(model.analytics)` returns the atomic catalog keyed `<field>.<agg>` / `<field>`, proving
   SEM-2's "never emit atomic entries" contract against the real deriver.
2. **the grain oracle** — `diagnoseAggregate(model.analytics, input)` returns no findings for the safe shape.
3. **measure** — `runAggregateDrizzle(db, model, input)` on real rows, asserting `plan.needsCte === true`,
   `plan.groupGrain === 'account'`, and the exact rows.
4. **the trap itself** — the same question as a naive single-pass join, asserted to return the *wrong* count. Without
   this the `needsCte` assertion is a claim about an implementation detail; with it, the test demonstrates a
   correctness property.

**Skips, both named and printed:**

- no sibling checkout (`QUERY_SURFACE_PATH`, else a sibling-relative probe) → skip, print the env var;
- no Docker → skip, print why (the `obs-list-reads` precedent).

Neither is a filter: each is a whole-suite skip with a stated reason, visible in the run output.

**Where it runs:** `just test-semantic-integration`, plus a step in the CI `integration` job — which already has
Docker. A gate that is in no CI job rots (CLAUDE.md), and in CI this one will *skip*, loudly, until the package is
installable there. That is the honest state, recorded rather than hidden: what gates the emitter in CI today is the
golden snapshot and the relationship smoke's `tsc`; what this adds is the correctness proof, runnable by anyone with
the checkout and automatic the day the package publishes.

## Out of scope

- The Nest `QueryApplicationService` wrapper (T9). It needs a scope resolver and connection wiring that belong to a
  host, not to a codegen fixture; the package's own describe/aggregate primitives are the layer SEM-3 is proving.
- `query()` / `fetch` / `search` / compare — SEM-3 demonstrates the aggregate surface the semantic model exists for.
- Publishing the package, its Drizzle 1.0 peer, or `has_one` — query-surface#40, operator-owned.
- EAV, `through:` relationships — PLAN §5.3, unchanged by this PR.

## Gates

| Gate | What it proves | Where it runs |
|---|---|---|
| `src/__tests__/emitters/semantic/golden-model.test.ts` (extended) | The widened `aggs`, the non-additive percentage and the junction shape are locked in the snapshot. | `just test-all` |
| `src/__tests__/emitters/semantic/golden-schema.test.ts` (new) | Every table the emitted snapshot references exists in `test/semantic-golden/schema.ts`, so the fixture barrel cannot drift from the model. | `just test-all` |
| `just test-smoke-relationship` | The tagged CRM slice still type-checks as an emitted model under the consumer tsconfig. | `just test-all` |
| `just test-semantic-integration` | **The demonstration.** describe + the grain oracle + a fan-out measure against real Postgres, with the naive counter-example. | its own CI step; skips with a printed reason without the checkout |
| `just test-all`, `just test-integration` | No regression. | CI |

## What downstream must know

- **The fan-out trap needs two measures, not one.** `needsCte` is `sources.length > 1` (T7). A single measure over a
  `has_many` plans `needsCte: false` with `rootJoinWouldFan: true` and is still correct; the CTE split is what keeps a
  *second*, parent-grain measure from being counted once per child row.
- **Dotted paths name the target entity, not the relationship key** (`opportunity.amount`, not `opportunities.amount`).
  The engine resolves an edge by `rel.target`, so SEM-2's choice of relationship key names does not affect
  resolution — but it does affect nothing else either, so queries must use entity names.
- **A column must carry `role: 'dimension'` to be groupable.** An untagged column is registered (filterable,
  resolvable) but `group_by` refuses it. Tag every dimension you intend to group by.
- **`describe` against a host-supplied model is `conformedDimensions` + `measuresFromRegistry`**, not
  `buildEntityCatalog` — that one reads the package's module-global introspected registry, which is the other path.
- **What must ship before `types.ts` can be deleted** — pattern-stack/query-surface#40 must (a) bump its
  `drizzle-orm` peer to the 1.0 line, (b) add the `has_one` relationship kind, and (c) publish. Then the three edits
  SEM-2 documented in `src/emitters/semantic/emit-types.ts`'s header apply:
  1. `TYPES_MODULE` in `emit-model.ts` → `'@pattern-stack/query-surface'`;
  2. drop `types.ts` from `SEMANTIC_FILES` in `src/emitters/semantic/index.ts`;
  3. add the optional peer dependency + its `peerDependenciesMeta` entry.
  The conformance test's named `has_one` expectation fails on (b) and names its own removal.
- **The engine already runs on Drizzle 1.0 for the host-supplied-model path** (T4/T5). Only the *introspection* path
  is blocked (T3). #40 is therefore smaller than "port the package to 1.0" for this project's purposes.

## Found during implementation

*(filled in at implementation; the spec is corrected to post-implementation truth in the same PR — charter §9.)*
