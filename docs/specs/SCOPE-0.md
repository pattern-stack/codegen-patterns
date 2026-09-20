# SCOPE-0 — generated and family finders discard the repository scope guards

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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

**Effect today, with no tenancy involved:** the generated and family finders passed their leaf predicate to
`.where()`, which replaces the scoped builder's condition, so the soft-delete exclusion and the `userTracking`
scope were dropped — a generated `findByEmail()` on a `soft_delete` entity returns soft-deleted rows, and a family
`findAllByUserId()` on a `userTracking` repository returns rows owned by other users once a requester context is
active. Pre-existing on `main`, independent of the Drizzle 1.0 bump.

`count()` is the same class of defect one step earlier: it hand-assembles the soft-delete + scope conditions
instead of calling `scopeAnd()` (`base-repository.ts:237-262`). **Correction to the issue text:** that duplication
was not dropping a guard — the conditions it listed were, today, exactly the ones `scopeAnd()` assembles, and the control
run below confirms `count()` passes every isolation assertion on the pre-fix tree. It is a **latent** defect: a
second declaration of the guard set that would silently miss any guard added to `scopeAnd()` later — which is
precisely what TEN-1 (#585) does. Fixed here so that cannot happen, not because it was wrong today.

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
`.where(` that lands on a builder `baseQuery(...)` returned. The detector (`findBaseQueryWhere`) balances
parentheses rather than matching a regex, so it catches the call **with any arguments** (`baseQuery(x).where(`,
`baseQuery(and(a, b)).where(`), **after other chain links** (`baseQuery(x).orderBy(y).where(`), across newlines,
and the **assigned** form (`const q = this.baseQuery(…); … q.where(` / `q = q.where(`), bounded to the enclosing
block so a same-named variable in another method is not read as the binding. The detector is itself unit-tested:
each forbidden form is asserted caught and each safe form asserted clean. *(Post-review correction: the first
version was the regex `baseQuery\(\s*\)\s*\.where\s*\(`, which saw only the zero-argument form.)* Same shape as DRZ-1's
`no-v1-relations-emission.test.ts`. It runs in `just test-unit`, therefore in `just test-all`, therefore in CI
(charter: *a gate that runs nowhere in CI rots*).

The `clean` pipeline's `repository.ejs.t` is excluded **by path, with the reason and the issue number in the
assertion** — it declares its own private `baseQuery()` and is #602/I11 territory. This is the named
single-purpose exclusion the charter permits, not a predicate that drops an error class.

**Considered and rejected: a type-level guard.** Returning `Omit<…, 'where'>` from `baseQuery()` is not airtight
(`.limit().where()` still compiles) and narrowing the `PgSelectKind` builder risks the `RowsOf` inference REL-0
measured generated bodies depend on. The shape test is airtight for every site codegen owns, which is the set that
matters.

### 3. Proof — three parts, because no single harness spans them

`test/scaffold/tests/scope-guards.test.ts`, run against Docker Postgres like the other scaffold suites.

**Semantics (real Postgres).** Over the scaffold's `crm_entities` table (real `user_id` + `deleted_at`,
`test/scaffold/schema.ts:42-52`) with an `IntegratedEntityRepository` declaring
`{ timestamps: true, softDelete: true, userTracking: true }` — both guards live at once — three rows are seeded:
one live row owned by user A, one soft-deleted row owned by user A, one live row owned by user B. Every assertion
is "only the first one". `findByExternalId`, `findManyByExternalIds`, `findAllByUserId` and `count()` each see
neither the soft-deleted row nor the other user's, including when the *leaf predicate itself* names the other user
(`findAllByUserId(USER_B)` as user A → `[]`).

**Per family.** The same three-row seed, with both guards on, is run against **every** finder of the other two
family bases — `ActivityEntityRepository` (`findByDateRange`, `findByUserId` ×2 including `findByUserId(USER_B)`,
`findBySubjectId`, `findRecentBySubjectId`) and `MetadataEntityRepository` (`findByEntityIdAndType`,
`listByEntityId`, `listHistoryByEntityId`); each returns only the live, owned row. To make that possible the
scaffold's `activity_entities` gains a nullable `deleted_at` and `metadata_entities` a nullable `user_id` +
`deleted_at` (`test/scaffold/schema.ts`); the families' own suites keep both guards off and are unaffected.
*(Added in review follow-up; the first version covered `IntegratedEntityRepository` only.)* Ten of the 17 sites are these base classes, and every generated
finder compiles to the same `baseQuery(leaf)` call, so the semantics are proven once, here.

The repositories under test extend the **real** runtime base classes; the ALS is imported through `@gen/`
(→ repo root) so the test cannot accidentally feed a different module's `AsyncLocalStorage`.

**Emission.** That the generated bodies *are* `baseQuery(<leaf>)` — for a unique query, a non-unique query, a
multi-column `and(...)` query and an FK-traversal method — is asserted in
`src/__tests__/clean-lite-ps/repository-template.test.ts`, plus a per-template negative on `baseQuery().where(`
and the repo-wide shape guard of §2.

**Compilation.** That those bodies type-check against the **real** base class is already gated by `just test-smoke`
and `just test-smoke-junction`, whose fixtures carry `queries:` blocks and whose generated projects are compiled
under a consumer tsconfig.

> **Why not simply run a generated finder?** No harness in this repo can. Generated code imports
> `@shared/base-classes/base-repository`, which `test/scaffold/tsconfig.json` resolves **scaffold-first** to
> `test/scaffold/shared/base-classes/base-repository.ts` — a hand-written stub with **no `baseQuery`, no
> `scopeAnd`, no `behaviors`**. A generated finder there would call a method its base class does not have. That is
> #608, a contract decision REL-0 deliberately deferred (the stub's `delete()` returns the row where the runtime
> returns `void`; its `findById` does not apply the soft-delete guard; its `upsertMany` updates by id where the
> runtime's inserts). Collapsing it is what would let one test span all three parts. The scaffold fixture is
> therefore left **unchanged** — see Found #2.

### 4. Snapshot churn — by class

**One class, two files, four bodies.** Nothing else moves.

1. **Junction repository snapshots** (`test/junction/__snapshots__/opportunity-{activity,contact}.test.ts.snap`) —
   the `findBy<Left>` / `findBy<Right>` bodies lose their `.where(...)` line and take the predicate as
   `baseQuery(...)`'s argument. Net `-8 / +4` lines across both files; the `.limit(opts?.limit ?? 100)` line and
   everything else is byte-identical.

**`test/baseline/` does not move at all** — it is generated with `architecture: clean`
(`test/fixtures/codegen.config.yaml:54`), and the `clean` pipeline is untouched (I11).

**No scaffold churn** — the fixture is unchanged (§3).

## Found during implementation

1. **The control run proves the finder tests are load-bearing; the `count()` tests are not (and why that is right).**
   With `runtime/base-classes/` reverted to the pre-fix state and everything else held constant,
   `just test-integration` reports **5 fail / 67 pass / 2 skip** — all five failures in the new file, with the
   pre-fix behaviour recorded as data:

   | Assertion | Pre-fix result |
   |---|---|
   | `findByExternalId` after a soft-delete | returned the soft-deleted row |
   | `findByExternalId` on a row owned by another user | returned that row |
   | `findManyByExternalIds([live, deleted, other])` | returned **3 of 3** |
   | `findAllByUserId(USER_A)` with one soft-deleted | returned **2** |
   | `findAllByUserId(USER_B)` | returned **1** — the leaf predicate replaced the scope condition |

   The per-family suite added in review follow-up has its own control: with only
   `activity-entity-repository.ts` + `metadata-entity-repository.ts` reverted to the pre-fix state, **all 8** of
   its tests fail (Activity ×5, Metadata ×3) and the rest of the suite passes (72 / 8 fail).

   The three `count()` tests **pass on the pre-fix tree**. That is the §Why correction above, stated as evidence
   rather than assertion: `count()`'s hand-assembled conditions were correct today and would have gone stale the
   moment TEN-1 added a predicate to `scopeAnd()`. The tests stay — they are what pins the refactor.

2. **The generated finders cannot be executed by any harness in this repo.** Generated code imports
   `@shared/base-classes/base-repository`, which `test/scaffold/tsconfig.json` resolves **scaffold-first** to
   `test/scaffold/shared/base-classes/base-repository.ts` — a hand-written stub with no `baseQuery`, no `scopeAnd`,
   no `behaviors` (zero occurrences of all three). So adding a `queries:` block to the scaffold fixture would emit a
   `findByEmail` that calls a method its base class does not have. The design's plan to prove the generated half at
   runtime there was **dropped**; §3 now records the three-part proof that replaces it, and the test file says so at
   the top. Closing that gap is **#608** (collapse the stub) — a contract decision, not a type change: the stub's
   `delete()` returns the row where the runtime returns `void`, its `findById` does not apply the soft-delete guard,
   and its `upsertMany` updates by id where the runtime's inserts. REL-0 deliberately deferred it and this PR does
   not pre-empt it.

3. **`user_tracking` emits no scope column in `clean-lite-ps`** — filed as **#617**. The behavior declares
   `created_by` / `updated_by` (`src/behaviors/user-tracking.ts:15-52`); `scopePredicate()` filters on
   `col('userId')`; and clean-lite-ps merges no behavior fields into the emitted table at all
   (`prompt-extension.js:1185` — `entity.ejs.t` has blocks for timestamps / soft-delete / external-id and none for
   user-tracking). No fixture in the repo declares `user_tracking`, which is why nothing had caught it. Out of scope
   here (an emission gap, not this bug), and the reason the scaffold fixture was left untouched.

4. **An existing test asserted the pre-fix emission.**
   `src/__tests__/clean-lite-ps/repository-template.test.ts` asserted `toContain('await this.baseQuery()')` —
   literally the broken shape — and so passed throughout. It now asserts the **argument**
   (`baseQuery(eq(this.table['email'], email))`), plus a negative on `baseQuery().where(`. This is the §Risks row
   "a test somewhere asserted the pre-fix result", materialised exactly once.

5. **Snapshot churn was as predicted: two files, four bodies, one class.** See §4 below; the baseline did not move.

## Out of scope

- **The `clean` pipeline's 9 sites** (#602, I11) — it has a different, private `baseQuery()`; it is not typechecked
  anywhere and is not repaired, filtered, or gated here.
- **Tenant scoping** (TEN-1, #585) — this PR only ensures the guard slot is not overwritten; TEN-1 adds a predicate
  to it.
- **`user_tracking` emitting no scope column in `clean-lite-ps`** — a real emission gap found while writing the
  test. Filed as **#617**; it is why the scaffold fixture was left unchanged (Found #3).
- **Collapsing the scaffold's second `BaseRepository`** (**#608**) — the reason a generated finder cannot be
  executed anywhere (Found #2). A contract decision, not a type change; not pre-empted here.
- **`upsertMany` / `integrationUpsertOne` / other raw statement paths** — they never called `baseQuery()`, so they
  are a different hole (TEN-1 §5).

## What downstream must know

- **`this.baseQuery().where(X)` is a build failure.** The form is `this.baseQuery(X)`; the guards are then assembled
  in exactly one place, `scopeAnd()`. `src/__tests__/templates/no-basequery-where.test.ts` scans `templates/` and
  `runtime/` on every `just test-unit`. **If your unit adds a tree that emits or ships repository code, add it to
  that test's `SCAN_ROOTS`.**
- **`count()` routes through `scopeAnd(where, { softDelete })`.** Any guard added to `scopeAnd()` now reaches
  `findById` / `findByIds` / `list` / `exists` / every finder / `update` / `delete` **and** `count()`. **TEN-1
  (#585) no longer needs a separate `count()` edit** — its §M1 finding is resolved here.
- **`baseQuery(leaf)` is the only read path with guards.** The raw-statement paths never called it and are still
  uncovered: `integrationUpsertOne`, `findByExternalIdProjected`, `softDeleteByExternalId`, `integrationUpsert`'s
  re-read, `metadata.upsertMany(conflictTarget)` and the FK resolvers. That is TEN-1 §5's territory, unchanged.
- **The FK-traversal template body no longer casts.** `let q = this.baseQuery(eq(this.table['<fk>'], id));` then
  `q = q.limit(opts.limit) as typeof q;` — REL-2/REL-3 rewrite these bodies and should keep the no-`any` property.
- **Two new follow-ups, both pre-existing:** **#617** (`user_tracking` emits no scope column in `clean-lite-ps`, so
  the behavior's declared columns and `scopePredicate()`'s column disagree — adjacent to TEN-1, which adds a second
  axis through the same assembly) and the existing **#608** (the scaffold's second `BaseRepository`, which is why no
  harness can execute a generated finder).

## Acceptance — all met

Output from the run made **after** the last edit (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | **exit 0** |
| `bun run build` | **exit 0** |
| `bun run test` | **exit 0** |
| `just test-all` | **exit 0** — typecheck · unit **3195/3195** (was 3176; +6 in the PR, +13 in review follow-up — the detector's own caught/clean cases) · baseline · smoke · smoke-subsystems (vendored + package) · smoke-relationship · smoke-junction · smoke-junction-cross-domain · junction snapshots 10/10 · integration-emit 56/56 · smoke-integration |
| `just test-integration` | **exit 0** — **80 pass · 2 skip · 0 fail** (was 64 pass; +8 the new suite, +8 per-family in review follow-up). Pre-fix controls: **5 fail** (Integrated) and **8 fail** (Activity + Metadata) |
| `just test-smoke` | **exit 0** — run as part of `test-all`; mandatory because `runtime/base-classes/**` changed |
| `just test-post-publish` | **exit 0** |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, still exactly **118**; not repaired, not filtered |

- No filtered error classes, no scope carve-outs in any gate's output. The one **path** exclusion in the new guard
  test is named, reasoned, carries #602, and is itself asserted to still be necessary.
- No new `any`, no `as unknown as`. One pre-existing `(q as any)` removed from the FK-traversal template body.

## Risks — outcome

| Risk | Outcome |
|---|---|
| A test somewhere asserted the pre-fix result | **Happened, once.** `repository-template.test.ts` asserted `toContain('await this.baseQuery()')` — the broken shape. Rewritten to assert the argument (Found #4). |
| The FK-traversal `as any` removal does not type-check under the consumer tsconfig | **Did not happen.** `q.limit(opts.limit) as typeof q` compiles in every smoke, including the junction and integration ones. |
| The scaffold fixture change breaks the existing suites | **Moot** — the fixture was not changed (Found #2). |

| Live risk | Signal | Response |
|---|---|---|
| A new repository method reintroduces the shape in a place the guard does not scan | a dropped guard with a green build | the guard scans `templates/` + `runtime/`; **add your directory to `SCAN_ROOTS`** if it emits or ships repository code |
| #602 is repaired or retired and the named exclusion goes stale | the guard's third test fails (`clean` no longer has the shape) | delete the exclusion — that test exists to force exactly this |
| A consumer hand-writes `baseQuery().where(...)` in their own repository | no signal; outside both scanned trees | documented loudly in `baseQuery()`'s docblock. A type-level guard was rejected (§2); revisit if it recurs |
