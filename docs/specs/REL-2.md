# REL-2 — Typed `with` includes on generated repositories, scoped at every hop

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-20
**Issue:** #587 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-0 (#603, `BaseRepository<TEntity, TTable>`) · REL-1 (#586, the `defineRelations()` manifest) ·
**TEN-1 (#585, ADR-042 tenant scoping) — hard, see §0** · **Blocks:** REL-3 (#588), FE-REL (#589)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter §4 I3/I4/I6) · PLAN §5A.4 ·
ADR-044 §1/§6/§7 · ADR-042 · ADR-043

## Why

REL-1 put the relation graph in the consumer's hands; nothing consumes it yet. REL-2 makes a nested read a
**generated** read: `findById(id, { with })` / `list(query, { with })` / the declarative `queries:` finders take a
typed include, resolved as one include tree from one root (charter I4).

The reason this is a `gate:human` issue is the other half: **every hop must be scoped**. A nested read that filters
the root by tenant and then joins a child table unfiltered is a cross-tenant read path wearing a type signature. The
spike below exists to decide *where* that predicate lives, and it found a version of exactly that failure in one of
the two candidates — with rows, against real Postgres.

## §0 — Standing on TEN-1 (written, and it shipped the shape this needed)

This spec's per-hop predicate is ADR-042's predicate, evaluated at a different point in the query. It therefore
**consumes**, and must not re-declare:

| From TEN-1 / ADR-042 §3–§4 | REL-2's use |
|---|---|
| `behaviors.tenantScoped` (from `tenant_scoped: true`) | one of the three flags a hop's scope config carries |
| `getTenantId(enforcement)` — three-state: a string, an explicit `null`, or absent (throws under `strict`) | called by the hop predicate, at query-build time |
| `scopeEnforcement: 'lenient' \| 'strict'`, default `strict` for tenant-scoped entities | decides whether a missing context is silence or a throw |
| `tenantPredicate()` inside `scopeAnd()` | REL-2 **refactors this into a shared builder** (§3) rather than writing a second copy |

> **Resolved 2026-09-20.** TEN-1 shipped (`8a88c6c`) while this was being implemented, and the shape matched: a free
> `tenantPredicateFor(table, tenantId, owner)` over any `PgTable`, plus `getTenantId(enforcement, owner)`,
> `MissingTenantIdError`, `RequesterContext.tenantId` / `.tenantScope`, `withTenantScope` / `withAllTenants`, a
> **required** `BehaviorConfig.tenantScoped`, and `scopeEnforcement: 'strict'` emitted for a `tenant_scoped: true`
> entity. This branch was rebased onto it and consumes exactly those; nothing was re-declared.
>
> **One divergence from TEN-1 §8, and it is structural.** §8 says *"The root's repository resolves `tenantId` ONCE per
> statement (one ALS read) and passes the value down; each hop calls `tenantPredicateFor(hopTable, tenantId, …)`."* It
> cannot: under the decision in §1.4 the hop predicate lives in the **manifest**, which has no call site to receive a
> value from — the same relation is reached by a hand-written `db.query.*` that never touches a repository. So each hop
> reads the ALS itself, through `getTenantId`. Measured equivalent: the callback runs once per *traversed* relation at
> statement-build time, the value is constant within a request, and a root-only read never invokes one (§1.2). TEN-1's
> §8 is otherwise consumed verbatim — including its instruction that "is the target entity tenant-scoped?" must travel
> as generated data rather than as `'tenantId' in getColumns(table)`, which is what the manifest's per-entity
> `ScopeConfig` constants are.

## Charter invariants this PR touches

- **I3 scope at every hop.** The whole subject. The spike's acceptance bar is not "can it be scoped" but "can an
  unscoped hop be *reached*" — §1 answers with a measured leak in the rejected candidate.
- **I4 one statement.** The include tree compiles to a single RQBv2 statement. No per-hop repository calls, no N+1.
- **I6 HTTP closed by default.** §5: no include is reachable over HTTP unless the entity YAML names it, and the
  client never supplies a tree.
- **I1 declare once.** The allowlist, the scope flags and the graph all come from YAML. The hop predicate is the same
  function the root uses (§3) — not a second implementation of the same rule.
- **I9 honest gates.** §6's leak tests assert *rows*, at depth ≥ 3, and each one is written to fail before the fix.

---

## §1 THE SPIKE (charter Q2) — where the per-hop predicate lives

Both candidates were built against the **installed** `drizzle-orm@1.0.0-rc.4` from inside the repo, over an identical
four-table schema (`accounts` · `contacts` · `opportunities` + an `opportunity_contacts` junction; every entity table
carrying `tenant_id`, `user_id` and `deleted_at`), with an `AsyncLocalStorage` stand-in for `RequesterContext`.

- **(a) manifest-level predefined `where`** — REL-1's emitter additionally emits, on every relation, a
  `where: { RAW: (t) => hopScope(t, <config>) }`. Traversal is scoped **by construction**.
- **(b) include-tree rewriting** — the manifest stays as REL-1 emits it; the repository walks the caller's `with`
  tree and injects a `where` at each level before executing.

### 1.1 Both produce correct, equivalent SQL

Candidate (a), a depth-3 include (`accounts` → `parentAccount`, `contacts` → `opportunities` *through* the
junction), with the ALS holding tenant `T1` — the three lateral subqueries, abridged to their `where` clauses:

```sql
-- parentAccount (self-reference, depth 1)
from "accounts" as "d1"
where (("d0"."parent_account_id" = "d1"."id") and ("d1"."tenant_id" = $1 and "d1"."deleted_at" is null))
-- contacts (depth 1)
from "contacts" as "d1"
where (("d0"."id" = "d1"."account_id") and ("d1"."tenant_id" = $4 and "d1"."deleted_at" is null))
-- opportunities THROUGH opportunity_contacts (depth 2)
from "opportunities" as "d2" inner join "opportunity_contacts" as "tr1" on "tr1"."opportunity_id" = "d2"."id"
where (("d2"."tenant_id" = $3 and "d2"."deleted_at" is null) and ("d1"."id" = "tr1"."contact_id"))
```

`params: ["T1", 1, "T1", "T1", "Child"]`. Candidate (b) produces the same predicates in the same places, with the
conjuncts in the other order. **Capability is not the deciding factor.**

### 1.2 The ALS is readable at query time — measured, not assumed

`RelationsFilter.RAW` accepts `SQLWrapper | ((table, operators) => SQL)`, and `relationsFilterToSQL`
(`drizzle-orm/relations.js:598-602`) invokes the function form **while building the statement**:

- the callback ran **3 times** for the depth-3 include above — once per *traversed* relation, not once per declared
  relation and not once at module load;
- the same query, built under a different ALS tenant, produced a different bind param (`["T2"]` vs `["T1"]`). The
  tenant is a per-request value in a per-request statement, which is the requirement;
- a query with **no** include never invokes a hop predicate at all, so root-only reads (background work, lenient
  contexts) are untouched.

This closes the spike's hardest question. A predicate baked into a module-level manifest would otherwise be frozen at
import time, which would have ruled (a) out.

### 1.3 Caller-supplied `where` / `limit` / `orderBy` compose — they do not override

```sql
-- with: { contacts: { where: { email: { like: '%@example.com' } }, orderBy: { email: 'asc' }, limit: 5 } }
from "contacts" as "d1"
where (("d1"."email" like $1) and ((("d0"."id" = "d1"."account_id") and ("d1"."tenant_id" = $2 and "d1"."deleted_at" is null))))
order by "d1"."email" asc limit $3
```

The caller's predicate is **AND**-ed with the relation's; `orderBy` and `limit` apply inside the lateral, after the
scoped `where`. A caller cannot widen the scope by supplying their own filter.

### 1.4 The decision — (a), because (b) has a reachable unscoped hop

RQBv2 traverses a relation in **two** places, not one:

1. the **include** (`with:`) — a lateral subquery, which an include-tree rewriter does see;
2. the **relational filter** (`where: { contacts: { … } }`) — an `EXISTS` subquery
   (`relations.js:618-632`), which an include-tree rewriter **never sees, because there is no `with` to rewrite**.

Under (a) both are scoped, because the predicate travels with the relation:

```sql
-- (a) where: { contacts: { email: { like: '%@acme.com' } } }
where exists (select * from "contacts" as "f0"
              where (((("d0"."id" = "f0"."account_id") and ("f0"."tenant_id" = $1 and "f0"."deleted_at" is null)))
                     and ("f0"."email" like $2)) limit 1)
```

Under (b) the second one is bare:

```sql
-- (b) same query — the rewriter is blind to it
where (("d0"."tenant_id" = $1 and "d0"."deleted_at" is null)
       and (exists (select * from "contacts" as "f0"
                    where (("d0"."id" = "f0"."account_id") and ("f0"."email" like $2)) limit 1)))
```

**Measured with rows, against real Postgres.** Seed: tenant `T1`'s account → contact → opportunity → junction graph,
plus three poison rows — a contact belonging to tenant `T2` pointing at `T1`'s account, a **soft-deleted** `T1`
contact, and an opportunity belonging to `T2` on `T1`'s account. Reading as `T1`:

| Query | (a) | (b) |
|---|---|---|
| root accounts | `["T1 Child", "T1 Parent"]` | same |
| depth-1 `contacts` | `["ok@t1.example"]` — both poison rows gone | same |
| depth-2 `opportunities` | `["T1 Deal"]` — cross-tenant opportunity gone | same |
| depth-3 contacts **through the junction** | `["ok@t1.example"]` | same |
| `where: { contacts: { email: { like: 'leak-%' } } }` | **`[]`** | **`["T1 Child"]`** |

That last row is the finding. Under (b) a caller in tenant `T1` learns that a row matching `leak-%` exists — a row
that is either another tenant's or soft-deleted. It is an existence oracle, it needs no `with:` to trigger, and it is
invisible to the mechanism that is supposed to prevent it.

**Decision: (a) — the per-hop predicate is emitted into the manifest.**

**The failure mode this rules out:** *a traversal path that the scoping mechanism does not know about.* Under (a) the
predicate is a property of the **relation**, so every consumer of that relation carries it — the include, the
relational filter, and (importantly) a hand-written use-case that calls `db.query.*` directly without going through a
repository at all. Under (b) the predicate is a property of the **call site**, so every new call site is a new chance
to forget. (b) also requires the repository to hold a runtime map of relation-key → target table to know which
predicate to inject — a second copy of the graph, against I1.

### 1.5 What (a) costs, and one thing it does not cover

- **Cost — an emit-time dependency.** The manifest stops being a pure description of the graph and starts importing a
  runtime helper. `<generated>/relations.ts` gains `import { hopScope } from '<runtime>'`. Acceptable: it is generated
  code in the consumer project, and it is the same import the generated repositories already carry.
- **Cost — the manifest can throw.** With `scopeEnforcement: 'strict'` and no ambient context, building a query that
  traverses a scoped relation throws (`no requester context`) **at query build, before any SQL is sent** — measured.
  That is the intended fail-closed behaviour (ADR-042 §4) and it is strictly better than the alternative, but it
  means a traversal is now a place a missing boundary surfaces. Root-only reads are unaffected (§1.2).
- **Not covered: the junction (`through`) table itself.** `relationToSQL` applies a relation's `where` to the source
  or target table; the through table gets only the join condition. Measured: a junction row whose own `tenant_id` is
  `T2`, linking two rows that both belong to `T1`, **is honoured** — the traversal returned
  `["ok@t1.example", "only-linked-by-t2@t1.example"]`, both `T1` rows.
  - **No data leak**: every returned row belongs to the reader's tenant. What a foreign junction row can do is
    *fabricate an edge* between two of the reader's rows.
  - **Today this is unreachable by construction**: `JunctionDefinitionSchema` is `.strict()` and has no scoping flag,
    so a junction table has no `tenant_id` at all, and writing a junction row goes through the junction's own
    generated repository. It is a **write-path** property (does `create` validate that both endpoints are in-tenant),
    not a read-path one.
  - **Recorded as a constraint on TEN-1 and on any later unit that makes junctions tenant-scoped:** if a junction
    ever carries a scope of its own, the `.through()` shortcut cannot carry it, and the traversal must go through
    REL-1's row-level edge (`opportunity → opportunityContacts → contact`), where each hop *is* a relation with its
    own `where`. REL-1 already emits that edge. §6 carries a test that pins the measurement so the day it changes is
    the day a gate goes red.

### 1.6 Why this only works because of REL-1's `from`/`to` decision

`relationToSQL` applies a relation's `where` to `relation.isReversed ? sourceTable : targetTable`
(`relations.js:683,690`), and `isReversed` is set exactly when a relation's columns were inferred from the reverse
side (`relations.js:60`). REL-1 emits explicit `from`/`to` on **both** sides of every relation, so `isReversed` is
never set and a hop's `where` always describes the **target** table — which is the table the predicate is written
against. Had REL-1 relied on reverse inference, half the emitted predicates would have been applied to the wrong
table, silently. This is a load-bearing consequence of REL-1 §R2; it belongs in the RC-bump checklist.

---

## §2 The typed include surface

### 2.1 Measured constraint: the include cannot live on the generic base

The same shape REL-0 measured for the statement builders (§M1) repeats for the relational query builder. With
`TRelations` and the relation key as naked type parameters:

```
error TS2536: Type '"with"' cannot be used to index type 'DBQueryConfig<"one", TRelations, TFields>'
error TS2353: Object literal may only specify known properties, and 'with' does not exist in type
              'KnownKeysOnly<DBQueryConfigWithComment<"one", TRelations, TRelations[TKey]>, …>'
```

So a `BaseRepository.findById<TWith>(…)` that types the include **cannot be written**. Where both are concrete — the
generated subclass — everything resolves. This is the design constraint, not a preference:

> **The typed include is emitted onto the generated repository. The base carries the handle, not the signature.**

### 2.2 `BaseRepository` gains `TRelations` — third, required

```ts
export abstract class BaseRepository<
  TEntity,
  TTable extends PgTable,
  TRelations extends AnyRelations,
> {
  protected readonly db: DrizzleClient<TRelations>;   // REL-1's alias, now bound
}
```

Verified to compile under `strict` + `noUncheckedIndexedAccess` together with the generated subclass below. Third
position, **no default** — the same I7 reasoning REL-0 applied to `TTable`: a default of `EmptyRelations` would make
a repository that forgot to pass its manifest compile and silently accept no includes.

Family repositories shift their remaining parameters right:
`IntegratedEntityRepository<TEntity, TTable, TRelations, TIntegrationWrite = Partial<TEntity>, TIntegrationProjection = TEntity>`,
`JunctionIntegrationRepository<TEntity, TTable, TRelations, TIntegrationWrite, TIntegrationProjection>`,
`Activity`/`Metadata`/`KnowledgeEntityRepository<TEntity, TTable, TRelations>`.

This is the **second** breaking arity change to the repository bases inside epic #580 (REL-0 was the first). That is
acceptable under I7 — and the two land close enough together that a consumer sees one migration, which is the
argument for doing it here rather than deferring.

### 2.3 What the generated repository emits

> **Corrected 2026-09-20.** The two type aliases below are not written per entity. The MANIFEST exports them once —
> `Relations`, `IncludeOf<TTable>`, `ResultOf<TTable, TWith>` — and each repository names its own:
> `export type AccountInclude = IncludeOf<'accounts'>;`. `IncludeOf` reaches the `with` slot through a CONDITIONAL
> indexed access, which is what makes a relation-less entity's repository compile at all (§2.5). Each repository also
> exports `<Entity>NoInclude` (the `TWith` default, `Record<string, never>`) and `<Entity>ApiResult` (§5.2).

```ts
// <generated>/relations.ts — once
export type IncludeOf<TTable extends keyof Relations> =
  'with' extends keyof DBQueryConfig<'one', Relations, Relations[TTable]>
    ? NonNullable<DBQueryConfig<'one', Relations, Relations[TTable]>['with']>
    : Record<string, never>;

// <entity>.repository.ts — per entity
export type AccountInclude = IncludeOf<'accounts'>;
export type AccountResult<TWith extends AccountInclude> = ResultOf<'accounts', TWith>;
export type AccountNoInclude = Record<string, never>;

export class AccountRepository extends BaseRepository<Account, typeof accounts, Relations> {
  protected readonly table = accounts;

  async findById<TWith extends AccountInclude>(
    id: string,
    opts?: { with?: TWith },
  ): Promise<AccountResult<TWith> | null>;

  async list<TWith extends AccountInclude>(
    query?: ListOptions & { with?: TWith },
  ): Promise<Array<AccountResult<TWith>>>;

  // one per `queries:` entry, same shape
  async findByParentAccountId<TWith extends AccountInclude>(
    parentAccountId: string,
    opts?: { with?: TWith },
  ): Promise<Array<AccountResult<TWith>>>;
}
```

Verified at the call site, under the consumer tsconfig posture:

- `findById('x', { with: { account: { with: { opportunities: true } } } })` → `r.account.name` is `string` (the
  relation is `optional: false`, so the include is not nullable) and `r.account.opportunities[0]!.name` is `string`;
- a **misspelled** relation name, a relation belonging to a *different* table, and a misspelled **nested** relation
  name are each a compile error (three `@ts-expect-error` assertions, all satisfied);
- `findById('x')` with no include returns the plain row type — the surface is additive;
- **depth is uncapped internally**: a 5-hop include inferred at the call site resolved to the exact nested type
  (`r.account.opportunities[0]?.contacts[0]?.account.parentAccount?.name`). Charter I4 asks for one statement, not a
  shallow one; the depth cap is an HTTP concern only (§5).

`TWith` is inferred **at the call site**. Annotating an include literal with the `…Include` type widens it and loses
the exact result shape — a spike artifact worth recording, because it is what a consumer will hit if they hoist an
include into a `const` with a type annotation. The generated JSDoc says so.

The methods are `override`s with `TWith` **defaulted** to `<Entity>NoInclude`, which is what keeps them assignable to
the base's non-generic `findById(id)` / `list(options?)`: with no include the result is the plain row, so the base
contract (and `IBaseRepository`, which `BaseService` constrains on) still holds. Verified against the consumer tsconfig
by every smoke.

### 2.4 Two execution paths, one scope

`baseQuery()` (the core `select().from()` builder REL-0 typed) cannot carry a `with`. So:

| Call | Path | Root scope |
|---|---|---|
| no `with` | `baseQuery()` → `scopeAnd()` — **unchanged** | `scopeAnd()` |
| with `with` | `db.query.<key>.findFirst/findMany` (RQBv2) | `where: { AND: [ …caller…, { RAW: scopeSql } ] }` |

Measured: a repository-injected `RAW` on the RQBv2 root filter renders
`where (("d0"."tenant_id" = $2 and "d0"."deleted_at" is null) and ("d0"."name" = $3))` and composes with caller
conditions. **The root predicate must be the same function in both paths** — §3.

`ListOptions`' `page`/`pageSize`/`sort_by`/`sort_order` map onto RQBv2's `limit`/`offset`/`orderBy` — but **not** as a
pre-rendered expression. RQBv2 aliases the root table, so the list use-case's `sql\`${desc(accounts.createdAt)}, …\``
names a table that is not in scope inside the relational statement and Postgres rejects it (measured; §10 Found #2).
`ListOptions` therefore gained `sort?: SortTerm[]` — column keys + directions — which `BaseRepository.orderByOn(table,
sort)` renders against whichever handle the executing path holds, including the aliased one RQBv2 passes to an `orderBy`
callback. A raw `orderBy` combined with a `with` throws, naming the alternative.

The GATE-2 default-sort rule (`created_at desc, id desc` only when the entity has `timestamps`) carries over unchanged
in substance — it is the same `resolveListQuery` output, expressed as terms rather than as SQL.

### 2.5 An entity with no relation in the graph

`DBQueryConfig` has **no `with` slot** for a table whose `relations` are `Record<string, never>` — an entity with no
`relationships:` and no junction. Two separate consequences, and only one of them is solvable in the type system:

- the TYPE is solvable — `IncludeOf`'s conditional indexed access yields `Record<string, never>`, so every entity's
  `…Include` / `…Result` compile;
- the CALL is not — `findMany({ with: … })` is rejected by `KnownKeysOnly`, which maps the unknown key to `never`. A
  conditional spread does not get around it (measured: the deferred conditional widens to a union and loses the
  required key).

So the include-carrying method BODIES are gated at emit time on the entity declaring at least one non-transitive
`relationships:` entry. See §10 Found #1 for what that costs (a junction-only entity) and why the gate is answered from
the entity's own YAML rather than by re-deriving the graph in the hygen half.

---

## §3 One predicate builder, three call sites

The rule REL-2 must not break is that the root and the hops agree. So ADR-042's `tenantPredicate()` and
`BaseRepository.scopePredicate()` are lifted into one table-parameterised builder:

As shipped (`runtime/base-classes/scope-filters.ts`) — every function takes an `owner`, which names the repository or
the RELATION in a throw, so a misdeclaration points at the declaration that is wrong:

```ts
export interface ScopeConfig {
  tenantScoped: boolean;
  softDelete: boolean;
  userTracking: boolean;
  enforcement: 'lenient' | 'strict';
}

/** soft-delete ∧ user axis ∧ tenant axis, for ONE table, read from the ALS at call time. */
export function scopeFilter(table: PgTable, cfg: ScopeConfig, owner: string): SQL | undefined;

/** The same, shaped for a relation `where` — `sql`true`` when nothing applies. */
export function hopScope(table: PgTable, cfg: ScopeConfig, owner: string): SQL;

/** The two axes on their own, so the class can expose a handle on each. */
export function userScopePredicateFor(table, enforcement, owner): SQL | undefined;
export function tenantAxisPredicate(table, cfg, owner): SQL | undefined;
/** TEN-1 §3.1's primitive, rehoused here because this is what composes it. */
export function tenantPredicateFor(table, tenantId, owner): SQL | undefined;
```

Three call sites, one implementation:

1. `BaseRepository.scopeAnd()` — root, core builder: `scopeFilter(this.tableRef, this.scopeConfigFor(opts), owner)`
   AND-ed with the caller's `extra`. TEN-1's `scopePredicate()` and `tenantPredicate()` survive as one-line handles over
   `userScopePredicateFor` / `tenantAxisPredicate`, so nothing that called them changed and there is still exactly one
   implementation per axis.
2. The generated repository's RQBv2 root filter — `{ RAW: () => this.rootScopeRaw({ softDelete }) }`, which is
   `scopeFilter(...) ?? sql\`true\``.
3. The emitted manifest's relation `where` — `{ RAW: (t) => hopScope(t, ACCOUNTS_SCOPE, 'contacts.account') }`.

`column()` moved to `runtime/base-classes/table-columns.ts` in the same change: `scope-filters.ts` needs it and
`base-repository.ts` imports `scope-filters.ts`, so leaving it where TEN-1 put it is a cycle. Both `column` and
`tenantPredicateFor` are re-exported from `base-repository.ts`, so no existing import path changed.

`table` is taken at REL-0's widened `PgTable` (§M2) and columns are read with `getColumns` — the same `col()`
mechanics REL-0 landed, including its throw-on-missing-column. **Measured:** the RAW callback's parameter is typed as
the *concrete* `PgTableWithColumns<…>`, so a helper declared over `Record<string, unknown>` does **not** type-check;
declared over `PgTable` it does, under `strict` + `noUncheckedIndexedAccess`.

Each entity's scope config is emitted twice — once as the repository's `behaviors`, once as a manifest constant — and
both come from the same YAML declaration, so I1 holds (I1 is "derive from the declaration", not "emit once"). The
manifest constants are named per entity (`const ACCOUNT_SCOPE = { … }`) and emitted in REL-1's builder, beside the
edge they belong to.

### 3.1 REL-1's emitter changes

`src/emitters/relations/` gains, per relation, a `where: { RAW: (t) => hopScope(t, <TARGET>_SCOPE) }` whose config is
the **target** entity's declared scope. Three consequences for the REL-1 artefacts:

- the golden snapshot (`test/relations-golden/snapshot/relations.ts`) regenerates;
- `build-graph.ts`'s `RelationEdge` gains the target's scope config (from the target's `EntityDefinition`);
- a relation whose target has **no** scope at all emits no `where`, so a graph with no tenant/soft-delete/userTracking
  anywhere is byte-identical to what REL-1 emits today. The manifest does not grow for consumers who do not scope.

---

## §4 REL-3's contract — what the navigator will consume

Stated here so REL-3 does not have to re-derive it:

| Name | Shape |
|---|---|
| `<Entity>Include` | `NonNullable<DBQueryConfig<'one', Relations, Relations['<key>']>['with']>` — exported from the generated repository module |
| `<Entity>Result<TWith>` | `BuildQueryResult<Relations, Relations['<key>'], { with: TWith }>` — likewise exported |
| `findById<TWith extends …Include>(id, opts?: { with?: TWith })` | `Promise<…Result<TWith> \| null>` |
| `list<TWith extends …Include>(query?: ListOptions & { with?: TWith })` | `Promise<Array<…Result<TWith>>>` |
| `findBy<Cols><TWith extends …Include>(…cols, opts?: { with?: TWith })` | `Promise<Array<…Result<TWith>>>` (`unique: true` ⇒ `… \| null`) |
| the relation keys | the YAML relationship names, camelCased (REL-1) — the navigator's method names are these |

The navigator accumulates an include tree and calls **one** of the above once (charter I4). It never calls a sibling
repository — that is the CGP-358b composition REL-3 deletes. Because `TWith` is inferred at the call site, the
navigator's builder must thread the literal type through its own generic parameter rather than annotating it (§2.3).

---

## §5 The HTTP surface (charter Q3, I6) — closed by default

### 5.1 The YAML

```yaml
entity:
  name: account
  # …

api:
  includes:
    find_by_id:            # GET /accounts/:id
      max_depth: 2
      paths:
        - contacts
        - opportunities.account
    list:                  # GET /accounts
      max_depth: 1
      paths:
        - contacts
```

- Route keys are the generated read routes (`find_by_id`, `list`, and one per `queries:` entry by its finder name).
- `paths` are **dot paths** over relation keys. `max_depth` is an explicit cap; a path longer than it is a
  generation error, not a silent trim.
- **Absent ⇒ nothing exposed.** No `api.includes` block, or no entry for a route, means a client-supplied include on
  that route is a `400`. This is the default for every entity that exists today, so REL-2 changes no HTTP behaviour
  until a consumer opts in.
- `api: false` on the entity means the block is meaningless (there is no route); declaring both is a generation
  error, to catch the misunderstanding rather than ignore it.

### 5.2 The wire format and the validation rule

`GET /accounts/:id?include=contacts,opportunities.account` — a comma-separated list of dot paths. **A client never
sends a tree.** The emitter compiles the allowlist into a static, literal map in the generated controller:

As shipped, into `<generated>/api-includes.ts` — a sibling of the manifest, emitted in the same whole-set pass over the
same graph, so an allowlist can never name an edge the manifest does not carry:

```ts
export const ACCOUNTS_API_INCLUDES = {
  // find_by_id — max_depth 2
  find_by_id: {
    contacts: { contacts: true },
    opportunities: { opportunities: true },
    'opportunities.account': { opportunities: { with: { account: true } } },
  },
  // list — max_depth 1
  list: {
    contacts: { contacts: true },
  },
} as const satisfies Readonly<Record<string, RouteIncludes<'accounts'>>>;
```

The controller parses `include` into paths, rejects any path not a key of that map with
`400 { code: 'include_not_allowed', path }`, and **deep-merges the looked-up fragments**. Two properties follow:

1. the include tree handed to the repository is always one of finitely many compile-time literals, so there is no
   client-controlled tree construction at all (I6);
2. every allowlisted path type-checks against `<Entity>Include` at generation time (`satisfies`), so an allowlist
   naming a relation that does not exist fails the build rather than at runtime.

Declaring `opportunities.account` implies `opportunities` is emitted as a key too (a prefix of an allowed path is
allowed); `max_depth` is enforced at emit time on the declared paths, so it cannot be exceeded at runtime.

**Measured** (`strict` + `noUncheckedIndexedAccess`): the map above compiles, and both failure modes are build
errors — a key whose fragment names a relation the entity does not have, and one whose **nested** fragment names a
relation the *target* does not have. A lookup by a literal key keeps the fragment's literal type.

One honest consequence: the controller **merges** fragments at runtime, so the tree it passes down is one of finitely
many literals but not statically known — which makes the handler's result type the widened one. It is
`<Entity>ApiResult = <Entity> & Partial<<Entity>Result<<Entity>Include>>`: the row's own columns required, every
relation optional. Note the `Partial` — this was corrected during implementation, because
`<Entity>Result<<Entity>Include>` (the fully-included shape) claims every relation is *always present*, which no single
request produces, and the smoke's `tsc` said so. Internal callers (§2.3) keep the exact inferred type. The response is
serialized JSON whose OpenAPI schema is generated from the same allowlist.

The runtime half is `runtime/http/includes.ts` — deliberately framework-free, throwing `IncludeNotAllowedError` that the
generated controller maps to `BadRequestException`, so the rule is unit-testable without booting an app. The controller
validates `?include=` on **every** read route, including one whose entity declares no allowlist at all: `undefined`
there means "allow nothing", not "allow everything".

### 5.3 `api: false` neighbours — STRICT (decided 2026-09-20)

ADR-043 §6: `api: false` means "no network data plane" for that entity. ADR-044 §7 said an `api: false` entity "is not
reachable through an exposed neighbour **unless the allowlist names it**". Those were in tension. **The gate chose
strict (i):** an allowlist path that traverses an entity with `api: false` is a **generation error naming both
entities**, with no per-path override.

Three reasons, restated as the decision rather than a recommendation: the entities people mark `api: false` are
credentials and internal join tables; an override declared on the *neighbour* is invisible at the `api: false`
declaration site, so the closed entity's own YAML stops telling the truth about it; and nothing is lost, because an
entity that *should* be reachable through a neighbour can simply not be `api: false`.

ADR-044 §7 carries the dated revision note withdrawing its clause; ADR-043 §6 carries a note recording that its rule
now has no exception, and that the `api:` key gained an object form with one reader for both shapes. The rejected
reading (ii) is kept here so a later reader can see what was weighed.

Declaring `api.includes` together with `api: { enabled: false }` is the same error for the same reason — an entity with
no data plane has no route to expose an include on, and ignoring the block would hide the misunderstanding.

### 5.4 Not in scope for the HTTP surface

Per-hop `where` / `limit` / `orderBy` from a client. The allowlist exposes **shapes**, not queries. A consumer who
needs a filtered include writes a use-case. Internal callers keep the full typed include (§2.3).

---

## §6 Tests that prove it

Every one asserts rows or a status code, never `toBeDefined`. Each is written to fail first.

### 6.1 Leak tests — `just test-integration`, real Postgres (epic #580 exit criteria)

**Corrected 2026-09-20.** The design said the existing `account` / `contact` / `opportunity` set would gain
`tenant_scoped: true`. It did not, and the reason is worth keeping: that set is what proves **L8** — a graph declaring no
scope anywhere emits no hop predicates and behaves exactly as it did before. Scoping it would have deleted its own
counter-example, and would have forced an ambient context into REL-1's round-trip tests for no gain.

So the leak graph is a second, purpose-built one: `test/scaffold/entities/{region,site,sensor}-scaffold.yaml` +
`junctions/site_sensor.yaml`, every entity `tenant_scoped: true` with `soft_delete` and `user_tracking`. It gives the
depth-3 path `region { parentRegion { sites { sensors } } }` — the same shape §1.1 measured — with the junction at the
last hop. `test/scaffold/tests/relation-scope.test.ts`, 10 tests:

| # | Test | Poison row | Asserted |
|---|---|---|---|
| L1 | depth-3 include as tenant A | a tenant-B row at each of depth 1, 2 and 3 | every returned row at every level belongs to A, out of four candidates per level |
| L1b | a child whose PARENT is tenant B's | — | the include is `null`, not the foreign row, and not an error |
| L2 | depth-3 include, soft-delete | a soft-deleted row at each level | absent at every level, parent included |
| L3 | depth-3 include, `userTracking` | another user's row at each level | absent at every level |
| L3b | the OTHER user reads the same graph | — | they see their own rows; documents that the ROOT is TEN-1's to guard and the HOP is REL-2's |
| L4 | **the §1.4 finding** — `where: { sites: … }` with **no** `with:` | three rows matching `leak-%`: tenant B's, soft-deleted, another user's | the root returns `[]`; the same query for a readable row DOES match, so the filter is scoped rather than broken |
| L5 | the `.through()` hop, both directions | a tenant-B row on the far side | absent either way |
| L6 | **the §1.5 residual, pinned** | a second junction row linking two tenant-A rows | the fabricated edge **is** honoured and every returned row is A's; the junction table is asserted to carry neither `tenantId` nor `deletedAt`, which is the fact that makes this a write-path property |
| L7 | `strict`, no ambient context, traversing query | — | throws at `.toSQL()` — before any SQL is sent |
| L8 | no `with:`, no context | — | works, on BOTH graphs: the scoped one root-only, and the unscoped account graph with a full include |

**Mutation-checked**: removing the `where` from the manifest emission turns 8 of the 10 red. The two that stay green are
L3b and L8 — the two that assert *unchanged* behaviour.

### 6.2 HTTP tests — the scaffold's Nest app, `just test-integration`

`test/scaffold/tests/relation-includes-http.test.ts`, 10 tests over two GENERATED controllers the scaffold's
`app.module.ts` now mounts as-emitted: `/accounts` (declares an allowlist naming `contacts` only) and `/opportunities`
(has relations, declares no allowlist).

| # | Test | Asserted |
|---|---|---|
| H1 | `?include=contacts` on an allowlisted route | 200, the include present with the right rows |
| H1b | the same path on the `list` route | 200, present inside the `Page` envelope |
| H1c | no `?include=` at all | 200, the plain row, `contacts` absent |
| H2 | `?include=opportunities` — a REAL relation the allowlist does not name | 400 `include_not_allowed`, `path: 'opportunities'` |
| H2b | one bad path beside a good one | 400 naming the bad one — the whole request is rejected |
| H2c | `?include=contacts.account`, deeper than `max_depth: 1` | 400; the deeper shape was never compiled into the map |
| H2d | a misspelled path | 400, not a silent ignore |
| H3 | a DECLARED path exceeding its route's `max_depth` | rejected at **generation** time (unit test on the emitter), so it cannot be requested |
| H4 | any `?include=` on a route with no allowlist | 400 — closed by default, even for a relation that exists |
| H4b/c | that route's plain read, and an EMPTY `?include=` | 200 both — an empty parameter is not a request for an include |
| H5 | a path traversing an `api: false` entity | generation fails; a unit test asserts the error names **both** entities |

One gap recorded rather than papered over: both controllers are **unscoped** entities. A tenant-scoped entity is emitted
`strict`, so a plain read of one over HTTP throws without an ambient requester context, and this harness installs no auth
boundary. The hops are proven by the leak tests and the allowlist by these; *an allowlisted include over a tenant-scoped
entity, end-to-end through HTTP* waits for a harness with a boundary (§10 Found #8).

### 6.3 Unit / golden — `just test-unit` → `just test-all`

- **`src/__tests__/runtime/base-classes/hop-scope-sql.spec.ts`** — the spike's measurements, promoted. Eight tests
  rendering real statements with `.toSQL()` (no Docker) over a manifest built the way the emitter builds one: the §1.1
  laterals at depth 3, the `.through()` hop scoping the target and not the junction, §1.2's per-request binding (the same
  query under a different tenant binds a different value) and its converse (a query with no include never invokes a hop
  predicate), §1.3's composition, and §1.4's `EXISTS` form — including that it fails closed with no context.
- **`src/__tests__/runtime/base-classes/scope-filters.spec.ts`** — 21 tests on the builder itself: the three-state
  tenant contract, `'org'` with an empty member list matching nothing, the conjunct ORDER, both strict throw sites,
  `withTenantScope` / `withAllTenants`, `hopScope` rendering `true` rather than nothing, and that `hopScope` and
  `scopeFilter` render identically (the "one implementation" property, asserted rather than asserted-in-prose).
- **`src/__tests__/emitters/relations/build-includes.test.ts`** — 17 tests: what compiles (prefix implication, route
  independence, depth) and every generation error, including the `api: false` one naming both entities.
- **`src/__tests__/runtime/http/includes.spec.ts`** — 12 tests on the request-time resolver: parsing, the merge rule
  (deeper fragment wins, order-independent), non-mutation of the shared literals, and that an absent allowlist rejects.
- **`src/__tests__/emitters/relations/route-name-parity.test.ts`** — the finder route key and the allowlist constant
  name, asserted identical on the TS and hygen sides (#711).
- **`src/__tests__/emitters/relations/build-graph.test.ts`** — `entityScope` precedence, and that every edge carries its
  TARGET's scope (including `null` for a hop into the junction TABLE, which is §1.5's characterisation).
- The **REL-1 golden snapshot** regenerates with the `where` clauses. Its fixture set is now deliberately mixed —
  `account` fully scoped (tenant + soft-delete + user-tracking ⇒ `strict`), `contact` soft-delete only ⇒ `lenient`, the
  rest unscoped — and a focused assertion walks every relation line: a scoped target MUST carry a `where`, an unscoped
  one MUST NOT.

### 6.4 Smoke

`just test-smoke-relationship` gained the allowlist fixture (`test/smoke/fixtures/crm/account.yaml`), so the emitted
`as const satisfies` map, the generated controller and the repository signatures all type-check in a real consumer
project. The smoke also asserts the manifest's `hopScope` import, the `ACCOUNTS_SCOPE` constant, the
prefix-implication key, that `list`'s allowlist did not inherit `find_by_id`'s paths, and that a route with no allowlist
still emits `this.resolveInclude(include, undefined)`.

---

## §7 Out of scope

- The navigator and the deletion of the CGP-358b composition methods (**REL-3**). §4 is the handoff.
  **Corrected 2026-09-20:** REL-2 could not stop *entirely* at the repository. §5's HTTP surface needs a path from the
  controller to the repository, so the generated service gained `findById` / `list` overrides that forward `opts` — pure
  delegation, no join logic, no sibling-repository calls, no navigator — and the two read use-cases gained the same
  pass-through. Everything REL-3 was going to build is still REL-3's.
- Frontend include accessors (**FE-REL**).
- Writes through a relation (nested create/update). ADR-044 §3: cross-entity writes are use-cases.
- Aggregation over a to-many path (charter I5 — that is query-surface).
- The `clean` pipeline (#602).
- Junction scoping (§1.5) — recorded as a constraint, not built.

## §8 Risks

| Risk | Signal | Response |
|---|---|---|
| ~~TEN-1 lands a predicate shape §3 cannot lift~~ | — | **Did not happen.** TEN-1 shipped `tenantPredicateFor(table, tenantId, owner)` as a free function over any `PgTable` — the shape §0 named. The one divergence (each hop reads the ALS rather than receiving a value) is structural, not a mismatch; §0 records it |
| A third breaking repository arity change | consumer friction | It is the second in this epic (REL-0 was first) and lands adjacent to it, so one migration. I7 permits it; the alternative — a default — is the silent failure §2.2 rejects |
| The manifest now throws under strict with no context | a traversal fails where a root read used to succeed | Intended (ADR-042 §4) and measured to fail *before* SQL is sent. L7/L8 pin both halves. It bit the harness exactly once, correctly: mounting a tenant-scoped generated controller with no auth boundary 500s, which is why §6.2's controllers are unscoped |
| `db.query` used directly by a use-case | — | Not a risk: the hops are scoped by construction. This is the main reason the manifest beats the rewriter |
| rc.4 → GA changes `RAW`'s call timing or `isReversed` | a leak test goes red | §1.2 and §1.6 are now permanent gates (`hop-scope-sql.spec.ts`), not one-off measurements, so an RC move that changes either is red in `just test-unit`. Carry them into DRZ-2's A-checklist |
| A relation-less entity's repository cannot compile | the smoke's `tsc` | **Happened, fixed** (§2.5 / Found #1): the include surface is gated on the entity declaring a relationship, and `IncludeOf` reaches `with` through a conditional so the TYPES compile either way |
| A pre-rendered `orderBy` cannot cross into RQBv2 | a 500 on an allowlisted `list` include | **Happened, fixed** (Found #2): `ListOptions.sort` describes the order; the repository renders it against the handle the executing path holds |

## §9 Gate decisions — all three settled (2026-09-20)

Recorded as decided; the implementation follows them.

1. **§5.3 — `api: false` neighbours: STRICT.** An allowlist path traversing an entity with `api: false` is a
   generation error naming both entities, with no per-path override. ADR-044 §7's "unless the allowlist names it" is
   withdrawn by a dated revision note; ADR-043 §6 gained a note saying its rule now has no exception. Enforced in
   `src/emitters/relations/build-includes.ts`; two unit tests assert the error and that it names both entities.
   Declaring `api.includes` beside `api: { enabled: false }` is the same error for the same reason.
2. **§2.2 — `TRelations` is a third REQUIRED type parameter** on `BaseRepository` and every family base, no default.
   The "one migration, two arity changes" trade is accepted: REL-0's `TTable` and this land in the same epic, adjacent
   enough that a consumer regenerates once. A default of `EmptyRelations` is what was rejected — it makes a repository
   that forgot its manifest compile and then silently accept no includes.
3. **§5.1 — route keys stay as specced**: `find_by_id`, `list`, and one per `queries:` entry by its finder name.
   Validated at generation time against the entity's own declarations, so a typo fails the build.
   One honest consequence, recorded rather than smoothed over: **only `find_by_id` and `list` have a generated HTTP
   route today.** The clean-lite-ps controller emits no route per `queries:` finder, so a finder route key is validated
   and its map is emitted, but nothing can reach it yet. The alternative — rejecting finder keys — would have made
   decision 3 meaningless the moment finder routes land.

---

## §10 Found during implementation

### Found #1 — a relation-less table cannot NAME a `with`, so the include surface is gated

`DBQueryConfig<'one', Relations, Relations[K]>` collapses to a `with`-less object when `Relations[K]['relations']` is
`Record<string, never>` — an entity with no `relationships:` and no junction. Two distinct problems followed, with two
different answers:

- **The TYPE.** `NonNullable<DBQueryConfig<…>['with']>` is a TS2339 for such a table. Solved in the emitted manifest
  with a conditional indexed access: `IncludeOf<TTable>` is `'with' extends keyof DBQueryConfig<…> ? … :
  Record<string, never>`. So `<Entity>Include` / `<Entity>Result` compile for every entity, uniformly.
- **The CALL.** `findMany({ with: … })` is still rejected — `KnownKeysOnly` maps the unknown `with` key to `never`, and
  no conditional spread gets around it (measured: the deferred conditional widens to a union and loses the required
  key). So the include-carrying method bodies are gated at emit time on `clpIncludes` — the entity declares at least
  one non-transitive `relationships:` entry.

The gate is deliberately answered from the entity's OWN YAML rather than by re-deriving the graph in the hygen half
(charter I1). The cost is recorded: **a junction-ONLY entity gets no typed include from the entity pipeline.** That
loses a feature rather than breaking a build, and #679's junction/relationship convergence is where it is decided — this
PR does not prejudge it. The residual risk in the other direction is narrow: an entity all of whose declared
relationships are skipped by REL-1 (every `target:` missing from the entity set) would emit a repository that does not
compile. REL-1 warns on that today; nothing in the repo is in that state.

### Found #2 — a pre-rendered `orderBy` cannot cross into RQBv2

The list use-case built its sort as one `SQL` fragment (`sql\`${desc(accounts.createdAt)}, ${desc(accounts.id)}\``) and
`baseQuery().orderBy(…)` consumed it. RQBv2 **aliases the root table** (`from "accounts" as "d0"`), so the same fragment
renders `order by "accounts"."created_at"` against a table that is not in scope — Postgres rejects the statement, and
the include path 500s. Measured on the scaffold's `/accounts?include=contacts`.

Fixed by describing the sort instead of rendering it: `ListOptions` gained `sort?: SortTerm[]` (column keys +
directions), `BaseRepository.orderByOn(table, sort)` renders it against whichever handle the executing path holds, and
the generated list use-case emits `sort` rather than `orderBy`. RQBv2's `orderBy` callback receives the aliased table,
which is what makes one description serve both paths. A raw `orderBy` combined with a `with` now **throws** naming the
alternative, rather than issuing SQL that cannot run. GATE-2's default-sort rule is unchanged in substance and its tests
were rewritten to the new shape.

### Found #3 — the `api:` key had to grow an object form, not a sibling key

§5.1's YAML shows `api: includes:`, but `api` was `z.boolean()`. A sibling top-level key would have split the HTTP
posture across two places. `api` is now `z.union([z.boolean(), ApiConfigSchema])` where `ApiConfigSchema` is
`{ enabled?, includes? }`, and **one reader** — `apiEnabled(def)` / `apiIncludes(def)` — serves both forms, so
`api: false` and `api: { enabled: false }` cannot diverge. The hygen half reads the same rule (`clpApiEnabled`), pinned
by a unit test. This is also what makes §5.1's "declaring both is a generation error" expressible at all.

### Found #4 — the scaffold's shadow `BaseRepository` had to go

`test/scaffold/shared/base-classes/base-repository.ts` was a second, drifted implementation that SHADOWED the runtime
base for `just test-integration` (`@shared/base-classes/*` resolves scaffold-first). REL-0 flagged it and deferred the
collapse as "a contract decision". REL-2 made it wrong rather than merely redundant: a generated repository now calls
`baseQuery` and `rootScopeRaw`, which the stub never had, so every generated read through it threw
`this.baseQuery is not a function`.

Both stubs (`base-repository.ts`, `base-service.ts`) are deleted; the suite runs against the real bases. Four
assertions changed, and all four had encoded the stub's drift rather than a contract: `update()` returns the row (a miss
is `undefined`, not `null`), `delete()` returns `void`, `findById()` **does** exclude a soft-deleted row, and
`upsertMany()` inserts rather than merging partials. The hand-written `DeleteContactUseCase` reads the row back so the
harness's DELETE route still answers with it.

### Found #5 — `user_tracking` emits `created_by`/`updated_by`, but the scope filters `user_id`

The user axis has always filtered `user_id`, and the `user_tracking` behavior has always emitted `created_by` +
`updated_by`. Nothing generated had exercised the pair, because every fixture that scopes on the user axis declares
`user_id` by hand. REL-2's leak tests are the first generated tables to apply the axis, and they threw
`regions.parentRegion: table has no column 'userId'`.

Worked around in the fixtures the same way the existing harness tables do (an explicit `user_id` field) and filed as
**#712**, because the fix is an emitted-column decision that belongs with the behavior contract, not with this PR.

### Found #6 — the known-red `clean` gate is 143, and 25 of them are REL-1's

`just test-smoke-junction-clean` was documented at 118. It is **143**, measured at three commits to establish
provenance: 118 at TEN-1's tip, 143 with REL-1 added, 143 unchanged with REL-2 on top. The +25 are all `TS2339` in
`src/generated/relations.ts` — REL-1 emits the manifest for both architectures because it derives from YAML, and the
`clean` pipeline's generated schema barrel does not export the tables it names, which is the same barrel gap already in
#602's diagnosis. Recorded in CLAUDE.md's known-red table with that attribution rather than re-baselined silently
(charter I9). REL-2 does not change the number.

### Found #7 — a fourth copy of the finder-name derivation

Validating an `api.includes` route key needs the `queries:` finder-name derivation in TypeScript; it already existed
three times in the hygen half. `src/schema/query-routes.ts` is the fourth, pinned against two of the three by
`route-name-parity.test.ts`. Filed as **#711** — the collapse onto one `.mjs` twin (the `runtime-mode.mjs` pattern) is a
refactor across three pipelines, not this PR's.

### Found #8 — two harness facts the scaffold needed for a generated controller

Mounting a generated module in the scaffold's Nest app surfaced two gaps, both fixed here:

- `@nestjs/swagger` was a peer dependency but not a devDependency, so a generated controller's decorators could not
  resolve in the scaffold. Added to `devDependencies` (the smoke installs it in its tmp project; the scaffold shares the
  repo's `node_modules`).
- Generated modules `@Inject(OPENAPI_REGISTRY)` at `onModuleInit`, and an AppModule provider is not visible inside an
  imported feature module. The scaffold now mirrors the `@Global() OpenApiModule` that `project init` emits — with
  `useFactory` rather than `useValue`, because this suite boots AppModule once per HTTP test FILE in one bun process and
  a shared registry makes the second boot throw `DuplicateSchemaError`.

The generated modules mounted are `AccountsModule` (has an allowlist) and `OpportunitiesModule` (has relations, no
allowlist). Both are **unscoped** entities on purpose: a tenant-scoped entity is emitted `strict`, so a plain read of
one over HTTP throws without an ambient requester context, and this harness installs no auth boundary. The scoped
graph's leak tests drive `db.query` directly, where a context is trivial to establish — recorded because it means
REL-2 does not prove an allowlisted include over a tenant-scoped entity end-to-end through HTTP. The hops are proven
(leak tests); the allowlist is proven (HTTP tests); the combination waits for a harness with a boundary.

---

## §11 Acceptance

Gate output from the run made **after** the last code edit (charter I9).

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run build` | exit 0 |
| `just test-unit` | **3415 pass**, 0 fail |
| `just test-all` | **exit 0** — typecheck + unit + baseline + `test-smoke` + `-subsystems` (vendored + package) + `-relationship` + `-junction` + `-junction-cross-domain` + `test-junction` (10 pass) + `test-integration-emit` (56 pass) + `test-smoke-integration`, every one PASS |
| `just test-integration` (Docker) | **141 pass**, 2 skip, 0 fail — including the 10 leak tests and the 10 HTTP allowlist tests |
| `just test-post-publish` | exit 0 — tarball smoke, consumer contract verified |
| `just test-smoke-junction-clean` | **143** — unchanged by this PR; see Found #6 |

**Mutation-checked.** Removing the `where` from the manifest emission turns **8 of the 10** leak tests red. The two that
stay green are the two that assert *unchanged* behaviour (L3b: the root is TEN-1's to guard, not REL-2's; L8: a read with
no include never invokes a hop predicate) — which is what they are for.

No new `any`, no `as unknown as`, no eslint disable in `runtime/**`. No filtered error class, no directory carve-out; the
one gate that is red is the documented `clean` one, reported at its real number with its provenance.

## §12 The spike code

Deleted, deliberately. It measured Drizzle's behaviour against a hand-built schema and two candidate manifests, none
of which is product code — keeping it would have left a test suite whose subject does not exist yet. Every
measurement it produced is reproduced above with its SQL and its rows, and §6.3 names the ones that become permanent
gates in the implementing PR, in `just test-unit` and `just test-integration` — both already in CI.
