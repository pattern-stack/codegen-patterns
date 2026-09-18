# REL-0 — `BaseRepository` generic over its concrete table

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #603 · **Epic:** #580 · **Project:** #578
**Depends on:** DRZ-2 (#584), GATE-2 (#604) · **Blocks:** TEN-1 (#585), REL-2 (#587)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5A.0 · ADR-044 · `docs/specs/DRZ-2.md` §A3/§A4

## Why

`runtime/base-classes/base-repository.ts` declares `protected abstract readonly table: PgTableWithColumns<any>`.
That `any` is the root of four things:

1. **Every insert needs an assertion.** Drizzle 1.0 derives an insert's `.returning()` row type from
   `TTable['$inferSelect']` (`pg-core/query-builders/insert.d.ts:84`). With `T = any`,
   `PgTableWithColumns<T> = PgTable<T> & T['columns'] & {…}` (`pg-core/table.d.ts:21`) collapses to `any`, so
   `TReturning` is `any` and the awaited result conditional
   `TReturning extends undefined ? PgQueryResultKind<…> : TReturning[]` distributes into
   `any[] | QueryResult<never>` — a union that cannot be indexed. DRZ-2 works around it with an `as TEntity[]` /
   `as Record<string, unknown>[]` assertion at the three insert sites.
2. **Every column access is a string index into `any`** — 32 `this.table['…']` sites across five files, unchecked.
3. **Every write payload needs `as any` / `as never`** — `values(data as any)`, `set(data as any)`.
4. **REL-2 has nothing to hang a typed `with` include on.** The include tree's type comes from the concrete table;
   `any` erases it.

The obvious narrowing (`PgTableWithColumns<TableConfig>`) does not work and was measured not to work in DRZ-2
(Found #1): a concrete `pgTable(...)` is **not** assignable to it, because `TableConfig['columns']` is
`Record<string, PgColumn>` and the concrete table type is an intersection of class-instance types with no implicit
index signature. It also makes `this.table['id']` `PgColumn | undefined` under the consumer tsconfig's
`noUncheckedIndexedAccess`. The repo's own `bun run typecheck` compiles no concrete subclass, so it reported green
for a change that produced ~40 errors in generated + vendored code.

REL-0 replaces the `any` with a real type parameter. TEN-1 edits the same `scopeAnd()` / `create()` choke point
immediately after, and REL-2 needs the concrete table type, so this lands first (charter §7, checkpoint 1).

## Charter invariants this PR touches

- **I9 honest gates** — no new `any`, no `as unknown as`, no filters, no loosened assertions. The repo's own
  `bun run typecheck` is known not to validate `runtime/base-classes/**`; every claim below was measured with `tsc`
  under `strict` + `noUncheckedIndexedAccess` against the **installed** `drizzle-orm@1.0.0-rc.4`, from inside the
  repo, and is gated by `just test-smoke` (+ junction, subsystems, integration, tarball).
- **I7 no backwards compat** — `TTable` is a **required** type parameter. No default, no one-arg overload, no
  parallel un-generic base. Baselines and snapshots regenerate.
- **I2 generated means regenerated** — the repository templates emit the new type argument; nothing is hand-edited
  into generated files.
- **I11 scope discipline** — `clean-lite-ps`, junction and relationship templates only. The `clean` pipeline's
  `templates/entity/new/backend/database/repository.ejs.t` imports `BaseRepository` from `'../base.repository'` — a
  module that does not exist (one of #602's 110 × TS2307) and is **not** this runtime's base class. It is therefore
  untouched: it neither constrains nor is constrained by this change.

## Measured facts — `drizzle-orm@1.0.0-rc.4`, `strict` + `noUncheckedIndexedAccess`

Probed with `tsc` from inside the repo (charter §8 risk: probing from outside resolves a transitive 0.45 copy).
These four measurements are what the design is built on; re-verify them on any RC move (they extend DRZ-2's
A1–A10 checklist — see §"A-checklist additions").

**M1 — a *naked type parameter* defers every drizzle builder conditional.** With
`class R<TEntity, TTable extends PgTable> { table: TTable }`, all four of these fail:

| Expression | Error |
|---|---|
| `db.insert(this.table).values(…).returning()` then `rows[0]` | TS7053 — `QueryResult<never> \| Assume<TTable, PgTable>["$inferSelect"][]` |
| `db.select().from(this.table)` | TS2345 — `TableLikeHasEmptySelection<TTable> extends true ? DrizzleTypeError<…> : TTable` never resolves |
| `this.table['id']` | TS7053 — `PgTable<TableConfig>` has no `id` |
| `db.update(this.table).set(…).returning()` | result `unknown` |

Parameterising over the table **config** instead (`TConfig extends TableConfig`, `table: PgTableWithColumns<TConfig>`)
does not help: the same conditionals stay deferred. The blocker is genericity at the call, not the constraint.

**M2 — the *non-generic* `PgTable` resolves all of them.** With a value of declared type `PgTable` (not
`PgTableWithColumns<TableConfig>`, not a type parameter):

| Expression | Result |
|---|---|
| `db.select().from(t)` / `.$dynamic()` / `.where()` / `.orderBy()` / `.limit()` | ✅ rows `{ [x: string]: unknown }` |
| `db.select({ count: sql<number>\`…\` }).from(t)` | ✅ |
| `db.insert(t).values(data).returning()` | ✅ indexable, **and `data: Record<string, unknown>` needs no `as any`** |
| `db.insert(t).values(d).onConflictDoUpdate({ target: PgColumn[], set }).returning()` | ✅ |
| `db.update(t).set(data).where(…).returning()` / `.returning({ id })` | ✅ |
| `db.delete(t).where(…)` / `.returning({ id })` | ✅ |
| `db.delete(t).returning()` (all columns, no projection) | ❌ TS7053 — union. **Not used anywhere in this repo.** |

And a concrete `pgTable(...)` **is** assignable to `PgTable` — `PgTable<out T extends TableConfig = TableConfig>`
is declared covariant, and a concrete config's `columns` is a mapped type, which does satisfy `PgColumns`. This is
exactly the property `PgTableWithColumns<TableConfig>` lacks, and is why the DRZ-2 narrowing failed where this one
does not.

**M3 — `getColumns` gives checked dynamic column access with no assertion.**
`getColumns(t: PgTable)` returns `Record<string, PgColumn>` (`utils.d.ts:56`), so
`getColumns(t)[name]` is `PgColumn | undefined` under `noUncheckedIndexedAccess` — a guard, not a cast.
`getTableColumns` is `@deprecated` on 1.0 (DRZ-2 §A5).

**M4 — the select builder's row type can be restored without `as unknown as`.**
`PgSelectKind` and `AnyPgSelectQueryBuilder` are exported from `drizzle-orm/pg-core`, and `PgSelectDynamic<T>` is
just `PgSelectKind<…, T['_']['result'], …>` (`pg-core/query-builders/select.types.d.ts:103`). Substituting the
result slot retypes the builder in one step, and `scoped as RowsOf<typeof query, InferSelectModel<TTable>>` is a
**single** assertion TS accepts (the two types overlap).

This is the measurement that makes the change cheap: because the generated entity type **is**
`InferSelectModel<typeof <table>>` (`templates/entity/new/clean-lite-ps/entity.ejs.t:75`), retyping `baseQuery()`'s
rows to `InferSelectModel<TTable>` makes every generated `rows as <Entity>[]` an identity assertion. Generated query
bodies compile **unchanged**. Without it they all fail TS2352 (`{ [x: string]: unknown }` does not overlap a concrete
entity interface) and every template body would have to be rewritten.

## Design

### 1. The type parameter

```ts
export abstract class BaseRepository<TEntity, TTable extends PgTable> {
  protected abstract readonly table: TTable;
  …
}
```

**`TTable` is always the second type parameter**, in every base in the family. `TEntity` stays explicit and is
**not** derived from `$inferSelect`: generated code already defines the entity as `InferSelectModel<typeof table>`,
so deriving it would be circular churn, and hand-written / `clean`-pipeline repositories legitimately pass a domain
type that is not the row shape. The two are tied together where it pays — `baseQuery()`'s row type (§3) — and
nowhere else.

| Class | After |
|---|---|
| `BaseRepository` | `<TEntity, TTable extends PgTable>` |
| `IntegratedEntityRepository` | `<TEntity, TTable extends PgTable, TIntegrationWrite = Partial<TEntity>, TIntegrationProjection = TEntity>` |
| `JunctionIntegrationRepository` | `<TEntity, TTable extends PgTable, TIntegrationWrite, TIntegrationProjection>` |
| `ActivityEntityRepository` | `<TEntity, TTable extends PgTable>` |
| `MetadataEntityRepository` | `<TEntity, TTable extends PgTable>` |
| `KnowledgeEntityRepository` | `<TEntity, TTable extends PgTable>` |

Services are untouched: `BaseService` and the family services constrain on the structural
`IBaseRepository<TEntity>` (`base-service.ts:38`), which names no table. `WithAnalytics` is a **service** mixin over
`Constructor<T>` and is likewise untouched — there is no repository mixin chain to thread the parameter through.

### 2. The statement seam

Per M1, the builders cannot be fed a naked `TTable`. Per M2 they are entirely happy with `PgTable`. So the base
widens, once, through a getter — a plain assignment, **not** an assertion:

```ts
/**
 * This repository's table widened to the non-generic `PgTable` the Drizzle
 * statement builders can resolve. … (measured: REL-0 §M1/M2)
 */
protected get tableRef(): PgTable {
  return this.table;
}
```

Every `select` / `insert` / `update` / `delete` in the base classes goes through `this.tableRef`. `this.table` keeps
the concrete type and is what subclasses and REL-2 read.

This is the one place the widening happens, and it is the site the issue's "gone or reduced to one justified,
commented site" refers to. It contains no `any` and no assertion.

### 3. Column access

```ts
/** Resolve a column by its camelCase key; throws when the table has no such column. */
protected col(name: string): PgColumn {
  return column(this.tableRef, name, this.constructor.name);
}
```

with a module-level `column(table: PgTable, name: string, owner: string): PgColumn` used for the *foreign* tables
too (`IntegrationFkResolver.refTable`, `JunctionIntegrationConfig.left/right.refTable`). It reads
`getColumns(table)[name]` (M3) and throws a named error when absent.

All 32 `this.table['…']` / `refTable['…']` sites in the base classes become `this.col('…')` / `column(refTable, '…')`.

**Behaviour note (intended, not a regression).** Today a missing column yields `undefined`, which is then handed to
`eq()` / `isNull()` and fails later with an opaque error, or silently renders wrong SQL. After REL-0 it throws
`<Repo>: table has no column 'deletedAt'` at the call. Nothing in the repo relies on the old behaviour; the same
posture already exists in `ActivityEntityRepository.subjectColumn`. Generated code is unaffected: it uses literal
keys on the **concrete** `this.table`, which are checked at compile time.

### 4. Typed reads

```ts
/** A `$dynamic()` pg SELECT builder with its row type replaced. */
type RowsOf<Q extends AnyPgSelectQueryBuilder, TRow> = PgSelectKind<
  Q['_']['hkt'], Q['_']['tableName'], Q['_']['selection'], Q['_']['selectMode'],
  Q['_']['nullabilityMap'], true, never, TRow[], Q['_']['selectedFields']
>;
```

`baseQuery(extra?)` returns `RowsOf<…, InferSelectModel<TTable>>` (M4). Consequences:

- `findById` / `findByIds` / `list` and every family finder get real rows instead of `any`.
- Generated repositories compile **unchanged** — their `rows as <Entity>[]` is now an identity assertion rather
  than a cast from `any`. They are left in place: removing them is REL-2/REL-3's template work, and doing it here
  would multiply the snapshot diff for no type-safety gain.
- A consumer's hand-written repository method built on `baseQuery()` keeps working and gets *better* typing.

### 5. What the `any`s become

| Site | Before | After |
|---|---|---|
| `base-repository.ts` `table` | `PgTableWithColumns<any>` | `TTable` |
| `base-repository.ts` `create()` | `.values(data as any)` + `as TEntity[]` | `.values(data)`, `rows[0] as TEntity` |
| `base-repository.ts` `update()` / `delete()` | `.set(… as any)` ×2 | no assertion |
| `base-repository.ts` `activeParentFilter()` | `parentTable: PgTableWithColumns<any>` | `parentTable: PgTable` |
| `integrated-entity-repository.ts` `integrationUpsertOne` | `as Record<string, unknown>[]`, `values(… as never)`, `set: … as never` | none |
| `integrated-entity-repository.ts` `resolveFk` | `refTable: PgTableWithColumns<any>` | `PgTable` |
| `junction-integration-repository.ts` `integrationUpsertOne` | `as Record<string, unknown>[]`, two `as never` | none |
| `junction-integration-repository.ts` `resolveStrict` / `resolveLoose` | `PgTableWithColumns<any>` ×2 | `PgTable` |
| `junction-integration-repository.ts` `JunctionIntegrationConfig` | `refTable: PgTableWithColumns<any>` ×2 | `PgTable` |
| `metadata-entity-repository.ts` `upsertMany` | `conflictTarget?: keyof PgTableWithColumns<any>['_']['columns']`, two `as any` | `conflictTarget?: keyof TTable['_']['columns'] & string`, no assertion |
| `integration-upsert-config.ts` `IntegrationFkResolver.refTable` | `PgTableWithColumns<any> \| 'self'` | `PgTable \| 'self'` |

`PgTableWithColumns` stops being imported by `runtime/base-classes/**` entirely. Target: **zero**
`PgTableWithColumns<any>`, zero `no-explicit-any` disables, and zero `as never` in `runtime/base-classes/*repository*.ts`.

### 6. Templates

| Template | Change |
|---|---|
| `templates/entity/new/clean-lite-ps/repository.ejs.t` | `extends BaseRepository<<Entity>, typeof <tablePlural>>` and `extends IntegratedEntityRepository<<Entity>, typeof <tablePlural>, <Entity>IntegrationWrite, <Entity>IntegrationProjection>` |
| `templates/junction/new/repository.ejs.t` | `extends JunctionIntegrationRepository<<Entity>, typeof <tableVar>, …Write, …Projection>` |
| `templates/relationship/new/repository.ejs.t` | `extends BaseRepository<<Entity>, typeof <tableVar>>` |

The table symbol is already imported in all three (it is the `readonly table = …` initializer), so no import
changes. Method bodies are untouched (§4).

### 7. The scaffold's second `BaseRepository`

`test/scaffold/shared/base-classes/base-repository.ts` is a **hand-written stub** with `table: any` that shadows the
real runtime base class for `just test-integration` (`@shared/base-classes/*` resolves scaffold-first). It is a
second declaration of a generated-code contract — exactly the drift GATE-1 deleted three other copies of — and it
means the integration suite has never exercised the real `BaseRepository`.

The design said **delete it**. The fallback — update its arity in place and file the deletion as its own issue —
is what shipped, and the reason is Found #3: the two contracts genuinely disagree about the shipped CRUD surface
(`delete()` returns the row vs `void`, `update()` returns `TEntity | null` vs `TEntity`, `list()` takes no options),
and `test/scaffold/tests/repository.test.ts` asserts the stub's behaviour. Collapsing them is a contract decision,
not a type change, so it is **#608**. REL-0 brought only the stub's table typing into line (`TTable` second, a local
`tableRef`, `getColumns`-backed `col()`), which removed its `table: any` and its two `as any` write payloads.

### 8. Specs and fixtures

`src/__tests__/runtime/base-classes/{base-repository,integrated-entity-repository,junction-integration-repository}.spec.ts`
build their tables as plain object literals cast `as unknown as PgTableWithColumns<any>`. `getColumns` reads
`table[Table.Symbol.Columns]`, which those fakes do not have, so they become real `pgTable(...)` definitions. This
is the point: a fake object cast to the table type is precisely what let the DRZ-2 narrowing look correct.
`test/scaffold/tests/*.test.ts` gain the second type argument.

## Found during implementation

1. **The design's four measurements all held.** M1–M4 were taken before any code was written and none needed
   revision — which is the whole reason this did not repeat DRZ-2's Found #1. In particular M4 paid for itself:
   because the retyped `baseQuery()` keeps every generated query body compiling, the entire snapshot churn for this
   PR is **two lines** (one `typeof <table>,` per junction repository snapshot) and the baseline did not move at all.

2. **Nothing in the repo typechecks `test/scaffold/`** — filed as **#608**. `bun run typecheck` excludes `test`,
   and `just test-integration` runs `bun test`, which strips types. Measured directly, with the pre-REL-0 base as
   the control:

   | | `tsc --noEmit -p test/scaffold/tsconfig.json` |
   |---|---|
   | base (`cd5d16d`, pre-REL-0) | **14** errors |
   | REL-0 | **12** errors |

   No new error class; the one line that differs is the same TS4113 with the base-class type rendered with its
   second type argument. REL-0 *fixed* two — the DRZ-2 `any[] | QueryResult<never>` insert class, surviving in the
   one copy of `BaseRepository` that no gate compiled. The residual 12 are pre-existing contract drift between the
   scaffold's hand-written stubs and the runtime base classes (#608).

3. **The scaffold's stub could not simply be deleted** (§7). It is a second declaration of the CRUD contract whose
   *behaviour* has drifted, not just its types.

4. **`WithAnalytics` needed no change, and neither did any service.** The issue and PLAN §5A.0 both list mixins as
   part of the thread. They are not: `BaseService` and the four family services constrain on the structural
   `IBaseRepository<TEntity>` (`base-service.ts:38`), which names no table, and `WithAnalytics` is a **service**
   mixin over `Constructor<T>`. There is no repository mixin chain, so the "if the generic cannot be threaded
   through the mixin chain, stop" risk never materialised. `with-analytics.ts` keeps its two pre-existing `any`s
   (`Constructor` and `analytics?`); they are unrelated to the table and out of scope here.

5. **The `clean` pipeline needed no change either.** `templates/entity/new/backend/database/repository.ejs.t`
   already emits a four-parameter, **table-first** `BaseRepository<typeof <plural>, <Class>, Create…, Update…>` and
   imports it from `'../base.repository'` — a module that does not exist, one of #602's 110 × TS2307. It is not this
   runtime's base class, so REL-0 neither constrains it nor is constrained by it. `just test-smoke-junction-clean`
   is unchanged at exactly 118.

6. **`PLAN.md` and `PROJECT.md` were deliberately not edited in this PR.** Charter §9 asks for PLAN updates in the
   same PR, but the checkpoint-1 revisions that introduced §5A.0 (and REL-0 itself) are in **unmerged PR #606**;
   this branch carries the pre-checkpoint copies. Editing them here would conflict with #606 and re-litigate its
   diff. The downstream facts are in the epic #580 body + log entry instead, and §5A.0 needs one correction once
   #606 lands: *"derive `TEntity` from `$inferSelect`"* was evaluated and rejected — see §1.

## Acceptance — all met

Output from the run made **after the last edit** (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | **exit 0** |
| `bun run build` | **exit 0** |
| `bun run test` (baseline) | **exit 0** — typecheck passed, all tests passed |
| `just test-all` | **exit 0** — typecheck · unit 3176/3176 · baseline · smoke · smoke-subsystems (vendored + package) · smoke-relationship · smoke-junction · smoke-junction-cross-domain · junction snapshots 10/10 · integration-emit 56/56 · smoke-integration |
| `just test-integration` | **exit 0** — 64 pass · 2 skip (pre-existing `test.skip` in `bridge-e2e.test.ts`) · 0 fail |
| `just test-post-publish` | **exit 0** — tarball contract + full consumer workflow from the tarball |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, still exactly **118**; not repaired, not filtered |

- `runtime/base-classes/**` contains **zero** `PgTableWithColumns` (one mention survives, in the `tableRef`
  comment explaining why), **zero** assertions on a `.returning()` result (`grep -rn "returning()) as\|returning() as"`
  → none), **zero** `as any` / `as never` on a `values()` / `set()` payload, and **zero** `as unknown as` introduced
  by this PR. The only remaining `@typescript-eslint/no-explicit-any` disable in the directory is
  `with-analytics.ts` (Found #4).
- **What deliberately stays:** `return rows as TEntity[]` on the *read* paths. Those are not the DRZ-2 workaround —
  they cast the table's select model (`InferSelectModel<TTable>`, which `baseQuery()` now returns) to the free
  `TEntity` parameter, which is precisely what a second, independent `TEntity` parameter means. They become
  identities wherever `TEntity` is the emitted `InferSelectModel<typeof table>`, i.e. in all generated code.
  Collapsing `TEntity` into `TTable` would remove them and is rejected in §1. Also pre-existing and untouched:
  `input as unknown as TIntegrationWrite` in `integrationUpsert` (a write-shape cast, no table involved).
- Snapshot churn: **two lines**, one per junction repository snapshot. The baseline (`clean` pipeline) is byte-identical.
- No filtered error classes, no scope carve-outs, no new gate excluded from CI.
- `docs/specs/DRZ-2.md` §2/§A3/§A4 corrected: the workaround they describe no longer exists.

### A-checklist additions (carry into the next RC / GA bump)

| # | Surface | Shape we depend on | Where it bites |
|---|---|---|---|
| A11 | `PgTable<out T extends TableConfig = TableConfig>` | covariant, and a concrete `pgTable(...)` is assignable to bare `PgTable` (unlike `PgTableWithColumns<TableConfig>`) | `BaseRepository.tableRef`, every base-class statement |
| A12 | builder conditionals vs. type parameters | `TableLikeHasEmptySelection<T>` (`select.types.d.ts:57`) and `TReturning extends undefined ? … : TReturning[]` (`insert.d.ts:96`) defer on a naked type parameter; they resolve for non-generic `PgTable` | why `tableRef` exists at all |
| A13 | `PgSelectKind` + `AnyPgSelectQueryBuilder` exported from `drizzle-orm/pg-core`; `PgSelectDynamic<T>` = `PgSelectKind<…, T['_']['result'], …>` | the 9-argument shape of `PgSelectKind` | `RowsOf<>` in `base-repository.ts` |
| A14 | `db.delete(t).returning()` with **no** projection is still a union for a non-generic `PgTable` | unused here; adding one would need the DRZ-2-style assertion back | — |

## Risks — outcome

- **A generated body fails TS2352 against the retyped `baseQuery()`.** Did not happen — every emitted query body
  is one of the shapes M4 covers. Kept as a live risk for REL-2/REL-3, which change those bodies.
- **`RowsOf<>` breaks on an RC move.** Open; A13 is the check.
- **Deleting the scaffold stub surfaces real divergence.** It did, before deletion — §7 / Found #3 / #608.
- **`col()`'s throw fires on a path that previously limped along.** Did not happen in any gate, including the
  Docker integration suite.

| Risk | Signal | Response |
|---|---|---|
| A generated body that is not one of the measured shapes fails TS2352 against the retyped `baseQuery()` | a smoke reports TS2352 in a generated repository | fix the template body (route it through `list()`/`findOne()`); do **not** widen `RowsOf`'s row type back to `unknown` |
| `RowsOf<>` breaks on an RC move | `tsc` errors inside `base-repository.ts` | A13; the fallback is to drop the retype and remove the generated casts instead — a template change, not a runtime one |
| Deleting the scaffold stub surfaces real divergence between it and the runtime base class | `just test-integration` fails in the scaffold, not in codegen | §7 fallback |
| `col()`'s throw fires on a path that previously limped along | an integration test throws `table has no column` | that path was already producing wrong SQL — fix the caller, do not restore the silent `undefined` |

## What downstream must know

- **`TTable` is always the SECOND type parameter**, on `BaseRepository` and on all four family repositories.
  It is **required** — there is no default (I7).
  - `BaseRepository<TEntity, TTable extends PgTable>`
  - `IntegratedEntityRepository<TEntity, TTable, TIntegrationWrite = Partial<TEntity>, TIntegrationProjection = TEntity>`
  - `JunctionIntegrationRepository<TEntity, TTable, TIntegrationWrite, TIntegrationProjection>`
  - `ActivityEntityRepository<TEntity, TTable>` · `MetadataEntityRepository<TEntity, TTable>` · `KnowledgeEntityRepository<TEntity, TTable>`
- **A generated repository spells its table type `typeof <entityNamePlural>`** — the same symbol it already
  imports for `readonly table = <entityNamePlural>` (`typeof opportunityContacts`, `typeof contacts`, …). There is
  no generated type alias to look up; `this.table` is that type inside the subclass.
- **Inside a base class, `this.table` is a naked type parameter and the Drizzle builders will not resolve against
  it** (§M1). Use `this.tableRef` (widened `PgTable`) for `select` / `insert` / `update` / `delete`, and
  `this.col('camelName')` for columns. Reserve `this.table` for what genuinely needs the concrete type — which is
  exactly what REL-2's typed `with` include is for.
- **`baseQuery()` now returns rows typed `InferSelectModel<TTable>`**, not `any`. A generated `rows as <Entity>[]`
  is an identity assertion today; REL-2/REL-3 can drop those casts when they rewrite the bodies.
- **`col()` throws** (`<Repo>: table has no column 'x'`) instead of yielding `undefined`. TEN-1's tenant predicate
  gets this for free: a `tenant_scoped: true` entity whose table has no tenant column fails loudly at the
  `scopeAnd()` choke point rather than rendering a filterless query.
- **TEN-1 (#585) edits `scopeAnd()` / `scopePredicate()` / `create()`**, all of which moved to `this.col(...)`.
  Rebase onto this before writing the predicate.
- **Do not reintroduce a second `BaseRepository`.** `test/scaffold/shared/base-classes/base-repository.ts` still
  shadows the runtime one for `just test-integration`, and nothing typechecks it — **#608**.

## Open questions

None. Q2/Q3 (charter §7) are REL-2's and are untouched by this PR.
