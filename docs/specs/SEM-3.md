# SEM-3 — the CRM vertical slice: the emitted model answers a fan-out-trap measure

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #592 · **Epic:** #581 · **Project:** #578
**Depends on:** SEM-2 (#591) · **Companion:** pattern-stack/query-surface#40 (issue) / #41 (the PR that fixes it)
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

## Verified — the sibling package does NOT run on Drizzle 1.0

> **This section was rewritten during implementation.** The design's first
> measurement said the package's engine runs on 1.0 and the demonstration could be automated. That measurement was
> made against the **wrong drizzle copy** — the charter's §8 hazard, walked into while quoting it. Corrected below;
> the mistake and how it was caught are Found #1.

Measured 2026-09-17, probing from inside this repo; probes deleted after measuring.

| # | Claim | Evidence |
|---|---|---|
| T1 | **query-surface#40 has not started.** Both checkouts (`query-surface`, `query-surface-40`) sit at `61c0df4`, `origin/main`'s tip. The package is `private: true`, `version 0.1.0`, peer `drizzle-orm ^0.45.2`, and `grep -rn has_one src/` is empty. | `git log --oneline -3` in both; its `package.json`. |
| T2 | `Relations`, `relations`, `createMany`, `createOne` are **absent** from 1.0.0-rc.4's root export; `getTableColumns`, `getColumns` and `defineRelations` are present. | Probe enumerating the root export. |
| T3 | The package's introspection path **value-imports** those removed APIs (`registry/introspect.ts:12`, `registry/schema-registry.ts:16`), and `src/index.ts` reaches it transitively. | Its source, plus T4. |
| T4 | **The package cannot be loaded against `drizzle-orm@1.0.0-rc.4` at all.** With module resolution made unambiguous, importing its barrel throws `SyntaxError: Export named 'createOne' not found in module …/drizzle-orm@1.0.0-rc.4/…/index.js`. | The suite's own loadability probe, which prints this verbatim when it skips. |
| T5 | The checkout has **no `node_modules`**, and neither does any directory between it and `/`. A bare `drizzle-orm` specifier inside it therefore resolves differently depending on how it is loaded — `bun <script>` auto-installs **0.45.2** from the global cache, `bun test` fails outright. | `ls` up the tree; the two contradictory probe results; the 0.45 path in the first failure message. |
| T6 | `AggEntity.table` has no reader in the package; `diagnoseAggregate(reg, q)` and `conformedDimensions(reg, entity)` take the **`AggRegistry`**, not the whole model; the Nest `QueryApplicationService` needs `(db, options)` with a required `scope` plus presentation wiring this slice does not have. | `internal/analytics/doctor.ts:22`, `join-plan.ts:249`, `query.application-service.ts:210-222`. |
| T7 | `needsCte` is **`sources.length > 1`** — measures spanning more than one source entity — not "a measure crossed a `has_many`". A single cross-`has_many` measure plans `needsCte: false, rootJoinWouldFan: true`. | `internal/analytics/grain.ts:93`, plus the probe runs in T8. |
| T8 | Given a model in exactly the shape SEM-2 emits, the engine derives `['amount.sum','amount.avg']` from the field tags, plans `{ groupGrain: 'account', needsCte: true, rootJoinWouldFan: true, sources: ['opportunity','account'] }`, and returns `Acme → pipeline 350, accounts 1` where a naive single-pass join returns `accounts 2`. **Measured under the mixed resolution of T5** (engine on 0.45, tables/db on 1.0), so it is evidence about the MODEL SHAPE and the expected answers — not evidence that the package runs on 1.0. | Probe, before T4 was understood. |
| T9 | A `has_one` edge does not disturb the engine's graph walks, which match on `belongs_to` / `has_many` and ignore an unknown kind. | `join-plan.ts` `belongsToPaths` / `directHasMany` / `reachableAny`. |

### Re-measured at review (2026-09-19) — against query-surface#41

T1–T8 describe query-surface `main` (`61c0df4`). The fix is query-surface#41 (head `ba816c3`, open): drizzle-orm 1.0
peer, `has_one`, publishable `0.2.0`. The retroactive review of PR #622 ran this suite against it:

| # | Claim | Evidence |
|---|---|---|
| T10 | #41's package **loads** against this repo's drizzle-orm 1.0.0-rc.4 (staged, per T5). | `engine: explicit (…)`, no load error. |
| T11 | Against the emitted model **as first shipped**, the demonstration was **5 pass / 4 fail**: `"account.name" is a non-dimension field, not a groupable dimension` — in "surfaces the emitted dimensions", "plans a per-source pre-aggregation", "returns the CORRECT rows", "a single cross-has_many measure". The golden `account.name` was untagged, and Found #3 already said untagged columns cannot be grouped. T8's rows came from a hand-built model, not the emitted artifact. | the review run |
| T12 | With `role: dimension` on `account.name` (golden + smoke CRM fixture) and the snapshot regenerated, it is **9/9** — plus the always-on engine-load check, 10 pass / 0 fail. | `QUERY_SURFACE_PATH=<#41 checkout> just test-semantic-integration`, after the last edit (Gate results) |

### Consequence: the demonstration runs wherever an engine is available — not yet in CI

T4 made the demonstration un-runnable against `main`; T10–T12 show it passes against #41. The package is not
published and CI has no checkout, so **in CI the suite skips, loudly, until SEM-4 installs the package** — adding
`@pattern-stack/query-surface` as a devDependency is the one edit that turns it on (docs/specs/SEM-2.md §4, item 8);
the suite resolves an installed package before any checkout. Until then the demonstration is a local gate against
a #41 checkout, and the epic's fan-out-trap exit criterion is **demonstrated against #41, not gated in CI**.

The value of T8 is that it fixed the test's assertions: the query shapes, the plan and the exact rows in
`test/integration/semantic-fanout.drizzle.integration.test.ts` are the measured ones, not guesses — and T12 confirms
them against the real emitted artifact.

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

Expected (T8): `plan = { groupGrain: 'account', needsCte: true, rootJoinWouldFan: true, sources: ['opportunity','account'] }`,
rows `Acme → pipeline 350, accounts 1`. The equivalent naive single-pass join returns `Acme → accounts 2` — Acme has
two opportunities, so the parent is counted once per child row. **That contrast is the test**, and the suite asserts
both sides so it demonstrates the trap rather than assuming it.

### Running it locally

Against a checkout of query-surface#41 (or any 1.0-line checkout):

```bash
QUERY_SURFACE_PATH=/path/to/query-surface just test-semantic-integration
```

Setting `QUERY_SURFACE_PATH` is a demand to run: a missing path or **any** load error fails the suite — it never
skips. The same recipe is a step in the CI `integration` job, where there is no engine today, so CI reports the skip
rather than hiding it.

## Scope

### 1. The slice — CRM fixtures gain the four tags the issue names

`test/smoke/fixtures/crm/` (the `test-smoke-relationship` set) and `test/semantic-golden/entities/` are edited in
step, so the snapshot locks exactly what the smoke compiles:

| Requirement | Where |
|---|---|
| additive money measure with `aggs: [sum, avg, min, max]` | `opportunity.amount` — widened from SEM-2's `[sum, avg]` |
| non-additive **percentage** | `opportunity.win_probability` — `role: measure`, `agg: avg`, `additivity: non` |
| `time: true` axis | `opportunity.closed_at` (already tagged by SEM-2) |
| the trap's group key | `account.name` — `role: dimension`. **Added at review:** it was untagged, so the fan-out query could not group by it (T11) |
| one `ratio` in `metrics:` | `win_rate = won_amount.sum / amount.sum` (already declared by SEM-2) |
| junction shapes | `test/semantic-golden/junctions/opportunity_contact.yaml`, shaped like the canonical `test/fixtures/junctions/opportunity_contact.yaml` (temporal, sourced, the five-value `role` enum) but declaring `role` with `choices:` — the canonical `values:` generates no column (#690). As first shipped this alignment changed nothing in the model (SEM-2 emitted no junction payload columns); since the SEM-2 review fix it emits `role`, the BaseJunctionFields and a payload field, and the snapshot locks them |

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

**The package source is staged into this repo before import.** The checkout has no `node_modules`, and neither does
any directory between it and `/`, so a bare `drizzle-orm` specifier inside it resolves by accident (T5). Copying
`src/` under `test/tmp/` makes resolution structural — the only `node_modules` on the path up is this repo's — so the
engine, the table objects and the db handle share one drizzle copy or the run fails loudly. This is what turned the
design's wrong answer into T4.

**Where the engine comes from, in order:** `QUERY_SURFACE_PATH` (an explicit checkout — never skips); an
installed `@pattern-stack/query-surface` (none today; what CI uses once SEM-4 adds the devDependency); a sibling
`../query-surface` checkout. Checkouts are staged; an installed package resolves drizzle-orm as a peer from this repo.

**Skips, each named and printed:**

- no engine from any source → print the three places it looked;
- no Docker → print why (the `obs-list-reads` precedent);
- an **auto-discovered** engine that is the pre-1.0 package → only on the exact error
  `SyntaxError: Export named '(createOne|createMany|Relations)' not found in module '…/drizzle-orm/index.js'`, printed
  verbatim, naming query-surface#41.

Anything else fails. **As first shipped the skip was not honest** (review of PR #622): `packageLoads()` caught every
error and reported it as "does not load against drizzle-orm 1.0", so on a fresh clone — where `test/tmp/` does not
exist and `mkdtemp` threw `ENOENT` — it printed the drizzle reason for a filesystem error; and an explicit
`QUERY_SURFACE_PATH` to a bad path skipped. Now: `test/tmp/` is created before staging; the skip matches the one
error above; an explicit path fails on a missing directory or any load error; and an always-on test (it runs even
without Docker) rethrows any load error that is not the named skip. Each path was exercised: #41 → 10/0; `main`
explicit → fails on `createOne`; `main` auto-discovered → 1 pass / 9 skip with the reason; `/nonexistent` → fails;
no `test/tmp/` → 10/0.

None is a filter: each is a whole-suite skip with a stated reason, visible in the run output.

**Where it runs:** `just test-semantic-integration`, plus a step in the CI `integration` job, which already has
Docker. A gate in no CI job rots (CLAUDE.md), so it is wired in now and **reports its skip in CI** until SEM-4
installs the package there. What gates the emitter in CI today remains the golden snapshot, the golden-schema test
and the relationship smoke's `tsc`.

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
| `src/__tests__/emitters/semantic/golden-schema.test.ts` (new) | Every table the emitted snapshot references exists in `test/semantic-golden/schema.ts`, so the fixture barrel cannot drift from the model. The junction table mirrors the junction template (composite key, no `id`); a named expectation pins that the junction `pk` names no column (#689). | `just test-all` |
| `just test-smoke-relationship` | The tagged CRM slice still type-checks as an emitted model under the consumer tsconfig. | `just test-all` |
| `just test-semantic-integration` | **The demonstration.** describe + the grain oracle + a fan-out measure against real Postgres, with the naive counter-example. **9/9 against query-surface#41** (T12); **skips in CI** (no engine installed) until SEM-4 adds the devDependency. | a step in the CI `integration` job, which reports the skip |
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
- **The fan-out-trap exit criterion is demonstrated against query-surface#41, not gated in CI.** 9/9 against #41's
  head `ba816c3` (T12). CI skips until SEM-4 installs the package.
- **What must ship before the mirror can be retired** — query-surface#41 must merge and publish (it carries the 1.0
  peer, `has_one` and `0.2.0`). Then SEM-4 applies the **nine-item, measured** list in docs/specs/SEM-2.md §4
  "Retiring the mirror" — the old three-edit recipe was wrong. Item 8 (the devDependency) is also what turns this
  suite on in CI; the suite already resolves an installed package first.
- **The conformance test is red against #41** (15/2) and retiring the mirror is its only exit (SEM-2 §4).
- **The pre-#41 package does not load on Drizzle 1.0 at all** (T4) — `src/index.ts` transitively reaches a value
  import of `createMany` / `createOne`. #41 is therefore not optional for this project.
- **Junction payload columns are in the model** (since the SEM-2 review fix); a junction's `pk` names no column
  (#689); `role: { values: … }` on a junction generates no column (#690).
- **Soft-deleted rows are summed unless the host's scope excludes them** — the model declares columns, not row
  filters (SEM-2 "what downstream must know").
- **Never probe the sibling checkout without staging it** (T5). It has no `node_modules`, so `bun <script>`
  auto-installs 0.45 from the global cache and quietly gives you a 0.45 answer, while `bun test` fails outright. The
  integration suite's `stagePackage()` is the pattern to copy.

## Found during implementation

### Found #1 — the design's central measurement was made against the wrong Drizzle copy

The spec as designed claimed the package's engine runs on 1.0 and the demonstration could be automated. It was
measured by importing the checkout's `src/index.ts` from a `bun` script inside this repo, which printed
`IMPORT OK — exports: 39`, after which a full fan-out query executed and returned correct rows.

That was the charter's §8 hazard — quoted in the same document it was violated in. The checkout has no
`node_modules` and neither does any parent directory, so `bun <script>` **auto-installed `drizzle-orm@0.45.2` from
the global cache** for it. The engine ran on 0.45 while the tables and db handle were 1.0.

It surfaced when the suite moved to `bun test`, where resolution failed instead of silently succeeding. Staging the
package under this repo (so the only `node_modules` on the path is this one) gave the real answer:
`SyntaxError: Export named 'createOne' not found in module …/drizzle-orm@1.0.0-rc.4/…`.

Two things changed as a result: the demonstration became a **manual gate** with a printed, named skip, and the
suite now stages the package rather than importing it in place. The T8 measurements survive as what they are —
evidence about the model shape and the expected answers, which is what the assertions are built from.

The generalisable lesson, already in the charter's risk table and now with a concrete instance: *"probe from inside
the repo"* is necessary but not sufficient. A dependency-less sibling has no copy of its own, so resolution can
still find one anywhere — or nowhere — depending on the runner.

### Found #2 — behavior-contributed columns never reached the model

Building the slice surfaced a real defect in SEM-2: `ParsedEntity.fields` holds only what the YAML `fields:` block
declares, so `behaviors: [timestamps]` put `created_at` / `updated_at` on the emitted table but **not** in
`analytics.fields`. The consuming layer reports an unregistered column, so nothing could filter or group on the most
obvious time axis in any CRM schema. SEM-2's spec asserted the opposite ("behavior columns … present in `fields`
with their type"); its unit test passed only because the fixture declared `created_at` explicitly.

Fixed here, from the declared source (`src/behaviors/`, keyed off the entity's own `behaviors:` list — still YAML,
still I1): behavior columns are expanded into `analytics.fields`, with `created_at` / `updated_at` / `deleted_at`
given `role: 'dimension'` so they are groupable. `time: true` is deliberately **not** derived — which column is the
time axis governs semi-additive summing and is the author's call, declared on a field they own. An explicitly
declared field always wins over the behavior default. SEM-2's spec row is corrected.

### Found #3 — a column must be tagged `role: 'dimension'` to be groupable

Measured against the engine: an untagged column is registered (resolvable, filterable) but `group_by` refuses it
— *"`name` is a column on opportunity but not a groupable dimension"*. This is why Found #2 matters, and why the CRM
slice tags `stage` and `closed_at` explicitly rather than relying on their being present.

### Found #4 — dotted measure paths name the target entity, not the relationship key

`opportunity.amount`, not `opportunities.amount`. The engine resolves an edge by `rel.target`
(`join-plan.ts` `directHasMany`), so SEM-2's choice to key relationships by their YAML names does not affect
resolution either way — but a query has to spell the entity.

### Found #5 — review fix (PR #622, REVISE): the emitted model could not answer the trap

The review ran the suite against query-surface#41 and got 5/4 (T11): Found #3 applied to the slice's own group key,
and nobody had run the emitted artifact through a 1.0-capable engine. `account.name` is now tagged (golden + smoke,
and the smoke asserts the tag), and the suite is 9/9 against #41 (T12). The skip was rewritten to be honest (§3), and
the engine is resolved from an installed package before any checkout, so the "un-skips with no edit" claims — here,
in `ci.yml`, in the justfile and on the epic — are replaced by what is true: it runs in CI once SEM-4 installs the
package. The hand-written golden schema had given the junction an `id` column the junction template never emits,
which is how SEM-2's phantom junction `id` survived the golden-schema test; it now mirrors the template.

## Gate results

Run after the last code edit, on `dugshub/592-crm-analytics-slice`:

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | clean / clean / all tests passed |
| `just test-all` | **exit 0** — 3323 pass / 17 skip / 0 fail across 207 files; every smoke PASS |
| `just test-integration` | **exit 0** — 64 pass / 2 skip / 0 fail |
| `just test-semantic-integration` | **9 skip / 0 fail**, printing its reason. With `QUERY_SURFACE_PATH` set it prints the `createOne` failure verbatim and names query-surface#40 — the honest state (T4) |

The 17 skips in `test-all` are SEM-2's conformance suite, unchanged.

**The smoke caught the fixture change, as designed.** Widening `amount` to `[sum, avg, min, max]` failed SEM-2's
`opportunity.amount measure tags` assertion on the first run; the assertion was updated and two more added (the
non-additive percentage, and a behavior-contributed `created_at` as a dimension), so the slice's new claims are
pinned in the smoke rather than only in the golden snapshot.
