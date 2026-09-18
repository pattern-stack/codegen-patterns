# SCOPE-0 — generated and family finders discard the repository scope guards

**Status:** Proposed
**Date:** 2026-09-17
**Issue:** #616 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-0 (#603) · **Blocks:** TEN-1 (#585)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · `docs/specs/REL-0.md` ·
`docs/specs/TEN-1.md` §M2 (where this was found)

## Why

`BaseRepository.baseQuery()` returns a `$dynamic()` SELECT that **already carries** the guard predicate —
soft-delete exclusion plus the `userTracking` scope, assembled by `scopeAnd()` (`base-repository.ts:345-355`).

Drizzle's `.where()` **replaces** the builder's condition. On the installed `drizzle-orm@1.0.0-rc.4`,
`pg-core/query-builders/select.js:548-554` is literally:

```js
where(where) {
  …
  this.config.where = where;
  return this;
}
```

So every call of the shape `this.baseQuery().where(<leaf>)` throws the guards away and issues
`WHERE <leaf>` alone. The method's own docblock warns about exactly this (`base-repository.ts:340-343`,
*"Pass the leaf predicate as `extra` rather than chaining a second `.where(...)`"*) — and then 17 call sites do
the thing it warns about, including the ones this repository generates.

**Effect today, with no tenancy involved:** a generated `findByEmail()` on a `soft_delete` entity returns
soft-deleted rows; a family `findAllByUserId()` on a `userTracking` repository returns every user's rows once a
requester context is active. Pre-existing on `main`, independent of the Drizzle 1.0 bump.

`count()` is a second instance of the same class: it hand-assembles the soft-delete + scope conditions instead of
calling `scopeAnd()` (`base-repository.ts:237-262`), so it can — and did — drift.

This lands ahead of TEN-1 (#585) because TEN-1's tenant predicate rides the *same* slot: without this fix, a
tenant-scoped `findByX()` would read every tenant, and TEN-1's central claim would be false. TEN-1 is human-gated;
this is not, and it is correct on its own.

## Charter invariants this PR touches

- **I3 scope lives at the repository.** A guard that the next chained call silently drops is not a guard. After this
  PR there is exactly **one** path from a leaf predicate to a statement — `scopeAnd()` — and it is not bypassable by
  chaining.
- **I9 honest gates.** The fix is proven by a guard test that fails on the *shape*, and by an integration test
  against real Postgres. No filtered errors, no new `any` (one existing `as any` is removed), and
  `just test-smoke` is run because `runtime/base-classes/**` changes.
- **I2 generated means regenerated** — the template bodies are the fix; nothing is hand-edited into emitted files.
- **I11 scope discipline.** `clean-lite-ps`, junction and relationship templates. The `clean` pipeline
  (`templates/entity/new/backend/database/repository.ejs.t`) has the same shape in 9 places but its own **private**
  `baseQuery()` with different semantics; it is known-red (#602) and untouched.

## The 17 sites + `count()`

| File | Sites |
|---|---|
| `templates/entity/new/clean-lite-ps/repository.ejs.t` | `:178`, `:183` (declarative `queries:` finders), `:206` (FK traversal) |
| `templates/junction/new/repository.ejs.t` | `:84`, `:100` |
| `templates/relationship/new/repository.ejs.t` | `:38`, `:43` |
| `runtime/base-classes/activity-entity-repository.ts` | `:78`, `:87`, `:96`, `:105` |
| `runtime/base-classes/metadata-entity-repository.ts` | `:54`, `:69`, `:77` |
| `runtime/base-classes/integrated-entity-repository.ts` | `:34`, `:45`, `:54` |
| `runtime/base-classes/base-repository.ts` | `count()` `:237-262` — bypasses `scopeAnd()` |

## Design

### 1. One path, no per-site guard logic

`baseQuery(extra?: SQL)` already takes the leaf predicate and routes it through `scopeAnd()`. Every site becomes:

```diff
-const rows = await this.baseQuery().where(<leaf>);
+const rows = await this.baseQuery(<leaf>);
```

`.orderBy()` / `.limit()` still chain off the returned builder, so no other line moves. No site gains guard logic
of its own — the point is that the guards are assembled in exactly one place and cannot be replaced from outside it.

`count()` stops hand-assembling and calls `this.scopeAnd(where, { softDelete: this.behaviors.softDelete })`.
Semantics are identical today; the difference is that it can no longer drift from `scopeAnd()` tomorrow — which is
how it came to be missing from the choke point in the first place.

While at `repository.ejs.t:206-208`, the FK-traversal body's `(q as any).limit(...)` becomes
`q.limit(opts.limit) as typeof q` — post-REL-0 the builder is typed, and I9 does not leave a gratuitous `any` on a
line this PR is already editing. Same idiom as `BaseRepository.list()` (`:222-224`).

### 2. The guard test

`src/__tests__/templates/no-basequery-where.test.ts` walks `templates/**` and `runtime/**` and fails on any
occurrence of `baseQuery()` followed by `.where(` (whitespace/newline tolerant). Same shape as DRZ-1's
`no-v1-relations-emission.test.ts`. It runs in `just test-unit`, therefore in `just test-all`, therefore in CI
(charter: *a gate that runs nowhere in CI rots*).

The `clean` pipeline's `repository.ejs.t` is excluded **by path, with the reason and the issue number in the
assertion** — it declares its own private `baseQuery()` and is #602/I11 territory. This is the named
single-purpose exclusion the charter permits, not a predicate that drops an error class.

**Considered and rejected: a type-level guard.** Returning `Omit<…, 'where'>` from `baseQuery()` is not airtight
(`.limit().where()` still compiles) and narrowing the `PgSelectKind` builder risks the `RowsOf` inference REL-0
measured generated bodies depend on. The shape test is airtight for every site codegen owns, which is the set that
matters.

### 3. Integration proof — real Postgres (`just test-integration`)

`test/scaffold/tests/scope-guards.test.ts`, run against Docker Postgres like the other scaffold suites.

**Generated finder.** `test/scaffold/contact-scaffold.yaml` gains `queries: - by: [email]` (→ a generated
`findByEmail`), an explicit nullable `user_id` field, and the `user_tracking` behavior. The test asserts a
soft-deleted contact and another user's contact are both invisible to `findByEmail()` under an active requester
context — the assertion that fails on `main`.

> The explicit `user_id:` field is deliberate. The `user_tracking` behavior definition declares `created_by` /
> `updated_by` (`src/behaviors/user-tracking.ts:15-52`), those behavior fields are **not** merged into
> `clean-lite-ps`'s `processedFields` (`prompt-extension.js:1185`), and `scopePredicate()` filters on
> `col('userId')` (`base-repository.ts:387`). So a `clean-lite-ps` entity cannot today get a scope column from the
> behavior alone — declaring the field is what a consumer must do. Noted as a follow-up; **not** fixed here (it is
> an emission gap, not this bug).

**Family finder + `count()`.** Over the scaffold's `crm_entities` table (real `user_id` + `deleted_at`,
`test/scaffold/schema.ts:42-52`) with an `IntegratedEntityRepository` declaring
`{ timestamps, softDelete, userTracking }`: `findByExternalId`, `findManyByExternalIds`, `findAllByUserId` and
`count()` each see neither the soft-deleted row nor the other user's row, while the owner's live row is returned.
`count()` is asserted separately because it is the site that bypassed `scopeAnd()` entirely.

The repositories under test extend the **real** runtime base classes. `@shared/base-classes/base-repository`
resolves scaffold-first to the hand-written stub (#608, REL-0 §7), so the direct base is imported via
`@gen/runtime/base-classes/…`; the family bases already resolve to the real source.

### 4. Snapshot churn — by class

Every changed snapshot falls into one of two classes, and nothing else moves:

1. **Junction repository snapshots** (`test/junction/__snapshots__/`) — the two `findBy<Left>` / `findBy<Right>`
   bodies lose `.where(...)` and gain the predicate as `baseQuery(...)`'s argument. Two lines per snapshot.
2. **Scaffold-generated contact module** — not snapshotted; it is emitted into a throwaway tree by
   `just test-integration` and deleted at teardown. The fixture change (a `queries:` block + one field) adds the
   `findByEmail` finder, its use-case, and the module registration.

`test/baseline/` does **not** move: it is generated with `architecture: clean`
(`test/fixtures/codegen.config.yaml:54`), and the `clean` pipeline is untouched.

## Out of scope

- **The `clean` pipeline's 9 sites** (#602, I11) — it has a different, private `baseQuery()`; it is not typechecked
  anywhere and is not repaired, filtered, or gated here.
- **Tenant scoping** (TEN-1, #585) — this PR only ensures the guard slot is not overwritten; TEN-1 adds a predicate
  to it.
- **`user_tracking` emitting no scope column in `clean-lite-ps`** — a real emission gap found while writing the
  test (§3). Filed separately; working around it with an explicit `user_id:` field is what the fixture does.
- **`upsertMany` / `integrationUpsertOne` / other raw statement paths** — they never called `baseQuery()`, so they
  are a different hole (TEN-1 §5).

## Acceptance

Gate output must come from the run made **after** the last edit (charter I9).

| Gate | Requirement |
|---|---|
| `bun run typecheck` · `bun run build` · `bun run test` | exit 0 |
| `just test-all` | exit 0, including the new guard test |
| `just test-integration` | exit 0, including the new isolation suite |
| `just test-smoke` | exit 0 — mandatory: `runtime/base-classes/**` changed |
| `just test-post-publish` | exit 0 |
| `just test-smoke-junction-clean` | still exactly **118** (#602) — not repaired, not filtered |

## Risks

| Risk | Signal | Response |
|---|---|---|
| A test somewhere asserted the leaky result | an existing suite fails after the fix | that assertion encoded the bug — fix the test and say so in the PR |
| The FK-traversal `as any` removal does not type-check under the consumer tsconfig | `just test-smoke` reports TS in a generated repository | use `list({ where, limit })` instead; do **not** restore the `any` |
| The scaffold fixture change breaks the existing HTTP / repository suites | `just test-integration` fails outside the new file | the added field is nullable and the finder is additive; if a create DTO assertion moves, update it |
