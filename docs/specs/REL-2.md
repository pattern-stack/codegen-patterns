# REL-2 — Typed `with` includes on generated repositories, scoped at every hop

**Status:** Awaiting strategy review (gate:human)
**Date:** 2026-09-17
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

## §0 — Standing on TEN-1, which is not written yet

This spec's per-hop predicate is ADR-042's predicate, evaluated at a different point in the query. It therefore
**consumes**, and must not re-declare:

| From TEN-1 / ADR-042 §3–§4 | REL-2's use |
|---|---|
| `behaviors.tenantScoped` (from `tenant_scoped: true`) | one of the three flags a hop's scope config carries |
| `getTenantId(enforcement)` — three-state: a string, an explicit `null`, or absent (throws under `strict`) | called by the hop predicate, at query-build time |
| `scopeEnforcement: 'lenient' \| 'strict'`, default `strict` for tenant-scoped entities | decides whether a missing context is silence or a throw |
| `tenantPredicate()` inside `scopeAnd()` | REL-2 **refactors this into a shared builder** (§3) rather than writing a second copy |

**TEN-1's branch (`dugshub/585-tenant-scoping`) was not pushed when this was written** — `git show
origin/dugshub/585-tenant-scoping:docs/specs/TEN-1.md` returns nothing. So the four rows above are taken from
**ADR-042 itself**, which is Accepted and is the contract both specs answer to. Two consequences, both flagged for
the reviewer:

1. **If TEN-1 lands a different predicate shape, §3 changes and this spec must be corrected before implementation.**
   The specific shape REL-2 needs is: *a function that, given a table and a scope config, returns the `SQL` predicate
   for that table, reading the ALS at call time.* ADR-042's `tenantPredicate()` is that function with the table fixed
   to `this.table`; REL-2 needs it parameterised. If TEN-1 writes it as a private method rather than a free function,
   REL-2's first change is to lift it — that is a one-function refactor, not a design disagreement.
2. **REL-2 must not merge before TEN-1.** Not for ordering hygiene — because §4's leak tests are meaningless without
   a tenant predicate to test. This is the same ordering PLAN §5A.2 already states.

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

```ts
type AccountInclude = NonNullable<DBQueryConfig<'one', Relations, Relations['accounts']>['with']>;
type AccountResult<TWith extends AccountInclude> =
  BuildQueryResult<Relations, Relations['accounts'], { with: TWith }>;

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

### 2.4 Two execution paths, one scope

`baseQuery()` (the core `select().from()` builder REL-0 typed) cannot carry a `with`. So:

| Call | Path | Root scope |
|---|---|---|
| no `with` | `baseQuery()` → `scopeAnd()` — **unchanged** | `scopeAnd()` |
| with `with` | `db.query.<key>.findFirst/findMany` (RQBv2) | `where: { AND: [ …caller…, { RAW: scopeSql } ] }` |

Measured: a repository-injected `RAW` on the RQBv2 root filter renders
`where (("d0"."tenant_id" = $2 and "d0"."deleted_at" is null) and ("d0"."name" = $3))` and composes with caller
conditions. **The root predicate must be the same function in both paths** — §3.

`ListOptions`' `page`/`pageSize`/`sort_by`/`sort_order` map onto RQBv2's `limit`/`offset`/`orderBy`. The
GATE-2 default-sort rule (`created_at desc, id desc` only when the entity has `timestamps`) carries over unchanged;
it is the same `resolveListQuery` output feeding a different builder.

---

## §3 One predicate builder, three call sites

The rule REL-2 must not break is that the root and the hops agree. So ADR-042's `tenantPredicate()` and
`BaseRepository.scopePredicate()` are lifted into one table-parameterised builder:

```ts
// runtime/base-classes/scope-filters.ts
export interface ScopeConfig {
  tenantScoped: boolean;
  softDelete: boolean;
  userTracking: boolean;
  enforcement: 'lenient' | 'strict';
}

/** The scope predicate for ONE table, read from the ALS at call time. */
export function scopeFilter(table: PgTable, cfg: ScopeConfig): SQL | undefined;

/** The same, shaped for a relation `where` (never undefined — `sql`true`` when nothing applies). */
export function hopScope(table: PgTable, cfg: ScopeConfig): SQL;
```

Three call sites, one implementation:

1. `BaseRepository.scopeAnd()` — root, core builder. `scopePredicate()`/`tenantPredicate()` become
   `scopeFilter(this.tableRef, this.scopeConfig)`.
2. The generated repository's RQBv2 root filter — `{ RAW: () => scopeFilter(this.tableRef, this.scopeConfig) }`.
3. The emitted manifest's relation `where` — `{ RAW: (t) => hopScope(t, ACCOUNT_SCOPE) }`.

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

```ts
const FIND_BY_ID_INCLUDES = {
  'contacts': { contacts: true },
  'opportunities': { opportunities: true },
  'opportunities.account': { opportunities: { with: { account: true } } },
} as const satisfies Record<string, AccountInclude>;
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

One honest consequence: the controller **merges** fragments at runtime, so the tree it passes to the repository is
typed `<Entity>Include` (the widened union of allowlisted shapes), not one literal — which means the HTTP handler's
static result type is the widened one. That is the right trade here: the response is serialized JSON whose OpenAPI
schema is generated from the allowlist anyway, and internal callers (§2.3) keep the exact inferred type. It is
recorded so nobody later reads the widening as a bug.

### 5.3 `api: false` neighbours — a decision for the reviewer

ADR-043 §6: `api: false` means "no network data plane" for that entity. ADR-044 §7: an `api: false` entity "is not
reachable through an exposed neighbour **unless the allowlist names it**". Those two are in tension, and REL-2 is
where it has to be resolved. Both readings, with a recommendation:

- **(i) Strict — recommended.** An allowlist path that traverses an entity with `api: false` is a **generation
  error**, naming both entities. `api: false` then means what ADR-043 says it means, with no exception, and the
  property is enforced by the build rather than by a reviewer noticing.
- **(ii) ADR-044 as written.** Naming the path in the allowlist is an explicit opt-in that overrides `api: false` for
  that one path.

(i) is recommended because the entities people mark `api: false` are credentials and internal join tables, the
override is invisible at the `api: false` declaration site, and nothing is lost: an entity that *should* be reachable
through a neighbour can simply not be `api: false`. **If the reviewer picks (i), ADR-044 §7 gets a dated revision
note in the implementing PR.** If (ii), ADR-043 §6 gets one instead. Either way one of the two ADRs is corrected —
this spec does not leave them disagreeing.

### 5.4 Not in scope for the HTTP surface

Per-hop `where` / `limit` / `orderBy` from a client. The allowlist exposes **shapes**, not queries. A consumer who
needs a filtered include writes a use-case. Internal callers keep the full typed include (§2.3).

---

## §6 Tests that prove it

Every one asserts rows or a status code, never `toBeDefined`. Each is written to fail first.

### 6.1 Leak tests — `just test-integration`, real Postgres (epic #580 exit criteria)

The scaffold harness already generates the graph REL-1 added (`account` with a self-reference · `contact` ·
`opportunity` · the `opportunity × contact` junction). It gains `tenant_scoped: true` and a second tenant's rows.

| # | Test | Poison row | Asserted |
|---|---|---|---|
| L1 | depth-3 include as tenant A | a tenant-B row reachable at each of depth 1, 2 and 3 | every returned row at every level belongs to A |
| L2 | depth-3 include, soft-delete | a soft-deleted row at each level | absent at every level |
| L3 | depth-3 include, `userTracking` | another user's row at each level | absent at every level |
| L4 | **the §1.4 finding** — `where: { <relation>: { … } }` with **no** `with:` | a tenant-B row and a soft-deleted row matching the filter | the root returns `[]` — no existence oracle |
| L5 | the `.through()` hop | a tenant-B row on the far side of the junction | absent |
| L6 | **the §1.5 residual, pinned** | a junction row owned by tenant B linking two tenant-A rows | the edge **is** honoured, and every returned row is A's. A characterisation test: when junctions become scopable this goes red, which is the point |
| L7 | `scopeEnforcement: 'strict'`, no ambient context, traversing query | — | throws before any SQL is sent |
| L8 | no `with:`, no context, lenient | — | behaves exactly as today (the hop predicate is never invoked) |

### 6.2 HTTP tests — the scaffold's Nest app, `just test-integration`

| # | Test | Asserted |
|---|---|---|
| H1 | `?include=contacts` on a route whose allowlist names it | 200, include present |
| H2 | `?include=opportunities.account` where only `contacts` is allowed | 400 `include_not_allowed` |
| H3 | `?include=a.b.c` exceeding `max_depth` | rejected at **generation** time (a unit test on the emitter), so it cannot be requested |
| H4 | any `?include=` on a route with no `api.includes` block | 400 — closed by default |
| H5 | an entity reachable only through an `api: false` neighbour | per §5.3(i): the generation fails; a unit test asserts the error names both entities |

### 6.3 Unit / golden — `just test-unit` → `just test-all`

- REL-1 golden snapshot regenerates with the `where` clauses; a focused assertion pins that **every** relation whose
  target is scoped carries one (a relation that lost its `where` is the regression this catches).
- SQL-shape tests over the emitted manifest using `.toSQL()` (no Docker): the §1.1 laterals, the §1.3 composition,
  and the §1.4 `EXISTS` form. These are the spike's measurements, promoted to gates once the code they measure
  exists.
- `satisfies` compile coverage for the allowlist map, via the smoke harness's `tsc` over a fixture that declares one.

### 6.4 Smoke

`just test-smoke-relationship` gains the allowlist fixture, so the generated controller + include map + repository
signatures all type-check in a real consumer project.

---

## §7 Out of scope

- Services and the navigator (**REL-3**). REL-2 stops at the repository; §4 is the handoff.
- Frontend include accessors (**FE-REL**).
- Writes through a relation (nested create/update). ADR-044 §3: cross-entity writes are use-cases.
- Aggregation over a to-many path (charter I5 — that is query-surface).
- The `clean` pipeline (#602).
- Junction scoping (§1.5) — recorded as a constraint, not built.

## §8 Risks

| Risk | Signal | Response |
|---|---|---|
| TEN-1 lands a predicate shape §3 cannot lift | REL-2's first commit fights TEN-1's | §0 names the exact shape needed. If it differs, correct this spec **before** implementing, not during |
| A third breaking repository arity change | consumer friction | It is the second in this epic (REL-0 was first) and lands adjacent to it, so one migration. I7 permits it; the alternative — a default — is the silent failure §2.2 rejects |
| The manifest now throws under strict with no context | a traversal fails where a root read used to succeed | Intended (ADR-042 §4) and measured to fail *before* SQL is sent. L7/L8 pin both halves |
| `db.query` used directly by a use-case | — | Not a risk under (a): the hops are scoped by construction. This is the main reason (a) beats (b) |
| rc.4 → GA changes `RAW`'s call timing or `isReversed` | a leak test goes red | §1.2 and §1.6 become rows in DRZ-2's A-checklist; re-verify on every RC move |

## §9 Open questions for the reviewer (gate:human)

1. **§5.3** — `api: false` neighbours: strict (recommended) or ADR-044's override? One of ADR-043 / ADR-044 gets a
   dated revision note either way.
2. **§2.2** — `TRelations` as a third **required** type parameter on every repository base, so soon after REL-0's
   `TTable`. Confirm the "one migration, two arity changes" trade.
3. **§5.1** — route keys in the YAML (`find_by_id` / `list` / finder names). Naming only; confirm before it becomes
   a consumer-facing surface.

## §10 The spike code

Deleted, deliberately. It measured Drizzle's behaviour against a hand-built schema and two candidate manifests, none
of which is product code — keeping it would have left a test suite whose subject does not exist yet. Every
measurement it produced is reproduced above with its SQL and its rows, and §6.3 names the ones that become permanent
gates in the implementing PR, in `just test-unit` and `just test-integration` — both already in CI.
