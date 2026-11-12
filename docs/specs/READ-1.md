# READ-1 — The generated read API: one options shape, one execution path, scoped everywhere

**Status:** Implemented (2026-11-11) — this document is the post-implementation truth; §10 records what building it changed
**Date:** 2026-11-11
**Issues:** #840 (caller `where` on the include path) · #841 (`columns` + `findByIds`) · #842 (`withRequester`) · #843 (exported scope) · follow-up #844 · **Project:** #578 · **Epic:** #580
**Depends on:** REL-2 (#587, typed `with` + per-hop scope) · TEN-1 (#585) · #791 (configurable tenant column, PR #839 —
this branch is stacked on it)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 — I1, I3, I4, I7, I9, I10
**Does not change:** REL-3's navigator contract (§4 of REL-2) except by widening it — see §9.

## Why

REL-2 made a nested read a generated read. A host application that adopted it for a real read model hit five gaps,
all in the same surface — the generated read methods — and two of them are the same defect class REL-2 already fixed
twice:

1. **A caller's `where` cannot cross onto the include path.** `list({ where: <SQL>, with })` renders the caller's
   pre-built SQL against the real table name while RQBv2 aliases the root (`"accounts" as "d0"`):
   `invalid reference to FROM-clause entry for table "accounts"`. Types are fine, so nothing catches it. This is
   REL-2 §10 Found #9 and Found #2 a **third** time — the root predicate and `orderBy` were fixed by "render against
   the table the callback is handed"; the caller's `where` was not.
2. **No root `columns` mask, and no many-by-ids read with options.** `findById` / `list` accept `with` (and a hop can
   carry `columns` inside it), but the ROOT cannot be narrowed, and `findByIds(ids)` takes no options. "Find ids with
   the builder, load the page by id with a narrow projection and a few to-one includes, in one statement" — the most
   common read-model shape there is — cannot be written through a generated repository at all.
3. **So the host hand-writes `db.query.*`**, which gets per-hop scoping (the manifest carries it) but **not root
   scoping**: the root is the repository's job and there is no repository on that path. The scope constants that would
   let a hand-written read apply the same root predicate are module-private in the manifest, so a loader must
   re-derive them from YAML — a second derivation (I1).
4. **`withRequester(ctx, () => db.query…)` silently leaves the context.** A Drizzle query is a lazy thenable: it is
   built — and the manifest's hop callbacks read the ALS — only when `.then` is called. `withRequester` is
   `als.run(ctx, fn)`; when `fn` returns the builder un-awaited, `als.run` returns first and the caller's `await` builds
   the statement outside the context. Under `strict` that throws `No requester context active`; under `lenient` it
   reads unscoped.
5. **The generated service drops `opts` on declarative finders** — `findByX(x)` forwards only `x`, so a typed include
   on a `queries:` finder is unreachable from the service layer.

The fix is not five patches. It is one read surface, specified once:

> Every generated read takes the same typed **read options** (`columns`, `with`, and — where a read returns many —
> `where`, `sort`, `limit`, `offset`), executes on **one** path, and renders every caller-supplied expression against the
> table handle that path holds. Scope is applied by one function at the root and by the manifest at every hop, on every
> method. Code outside a repository gets the same root scope from an exported constant.

## Charter invariants this touches

- **I3 scope at every hop — and at the root, on every path.** §3. The include path stops being a second path at all.
- **I4 one statement.** `findByIds(ids, { columns, with })` is one statement, not a loop (§2.3).
- **I1 declare once.** The scope constants are exported from the manifest, not re-derived by consumers (§5).
- **I7 no backwards compatibility.** `ListOptions.where: SQL` and `ListOptions.orderBy` are **replaced**, not
  supplemented — the unsafe shape stops existing (§4). `ResultOf`'s second parameter changes meaning (§2.1).
- **I9 honest gates.** Each defect gets a gate that fails on its own subject (§8). The SQL defect class gets shape
  gates over every call site this PR introduced (§4.2), each mutation-checked — a grep cannot rule out every spelling
  of the mistake, so the Docker suite (§8.3) remains the backstop.
- **I10 public repo.** The host case is described by shape only (§8.4).

---

## §1 What exists today (`main` + #839)

| Method | Options | No-option path | Option path | Root scope |
|---|---|---|---|---|
| `findById(id, { with })` | `with` | `baseQuery()` (core builder) | RQBv2 `findFirst` | `scopeAnd()` / `rootScopeRawOn(t)` |
| `findByIds(ids)` | — | `baseQuery()` | — | `scopeAnd()` |
| `list({ where: SQL, orderBy, sort, limit, offset, with })` | `with` | `baseQuery()` | RQBv2 `findMany`, caller `where` as `{ RAW: callerWhere }` **(broken)** | both |
| `findBy<Col>(v, { with })` (`queries:`) | `with` | `baseQuery()` | RQBv2 | both |
| `findBy<Fk>(id, { cursor, limit, with })` (`belongs_to`) | `with`, `limit` | `baseQuery()` | RQBv2 | both |
| `count(where: SQL)` | — | core | — | `scopeAnd()` |

Two execution paths per method, each with its own rendering of the caller's inputs, and the include path is only
exercised when a `with` is present. REL-2's Found #9 happened because one path was never driven on a scoped entity;
Found #2 and #840 happened because a value rendered for one path was carried into the other.

---

## §2 The read surface

### 2.1 Types the manifest exports (once, beside `IncludeOf`)

```ts
// <generated>/relations.ts
export type IncludeOf<T extends keyof Relations> = /* unchanged (REL-2 §2.3) */;

/** The root column mask of one table — `{ id?: boolean; name?: boolean; … }`. */
export type ColumnsOf<T extends keyof Relations> =
  NonNullable<DBQueryConfig<'many', Relations, Relations[T]>['columns']>;

/**
 * The row a read resolves to, given its options: each included relation nested
 * exactly as asked, the root narrowed by `columns` (absent ⇒ every column).
 */
export type ResultOf<
  T extends keyof Relations,
  TWith extends IncludeOf<T>,
  TColumns extends ColumnsOf<T> | undefined = undefined,
> = BuildQueryResult<Relations, Relations[T], { columns: TColumns; with: TWith }>;
```

`ResultOf` **gains** an optional THIRD parameter, the mask. REL-2's `ResultOf<T, TWith>` keeps its exact meaning, so
nothing written against REL-2 breaks (decided 2026-11-12, §10 Found #10 — the first cut put the mask first, which
turned a stale `AccountResult<AccountNoInclude>` into a silent `{}`).

**`columns` absent must mean "every column".** Measured against `BuildQueryResult`: `columns: undefined` takes its
`'Full'` branch; `columns: {}` takes the mask branch and resolves to **no** keys. So the "no mask" default for
`TColumns` is `undefined`, never `{}` / `Record<string, never>`. A `{}` mask at runtime is rejected (§2.4).

### 2.2 Per-entity names (the repository module)

```ts
export type AccountColumns = ColumnsOf<'accounts'>;
export type AccountInclude = IncludeOf<'accounts'>;           // unchanged
export type AccountNoInclude = globalThis.Record<string, never>; // unchanged — TWith default
export type AccountResult<
  TWith extends AccountInclude = AccountNoInclude,
  TColumns extends AccountColumns | undefined = undefined,
> = ResultOf<'accounts', TWith, TColumns>;
```

`<Entity>Result` takes defaults on both, the include first: `AccountResult` alone is the plain row,
`AccountResult<W>` is exactly REL-2's `AccountResult<W>` (so `AccountResult<AccountNoInclude>` is the row, not `{}`),
and `AccountResult<AccountNoInclude, { id: true }>` is `{ id: string }`. A mask in the first slot shares no key with
the include surface and is a compile error (TS2559). `<Entity>ApiResult` (HTTP) is unchanged — HTTP takes no
`columns` (§7).

**One order everywhere: `with` first, `columns` second.** The methods' type parameters (`<W, C>`), `ReadOptions<W, C>`
and `<Entity>Result<W, C>` all follow it, so the generated `rows as <Entity>Result<W, C>` reads straight off the
signature and the generated use cases pass `findById<TWith>` / `list<TWith>` with no `undefined` placeholder. Call
sites infer both, so the method order is not a consumer-facing choice.

### 2.3 The methods (emitted on every generated repository — REL-2 §2.1's TS2536 still binds)

```ts
findById<W extends AccountInclude = AccountNoInclude, C extends AccountColumns | undefined = undefined>(
  id: string,
  opts?: { with?: W; columns?: C },
): Promise<AccountResult<W, C> | null>;

findByIds<W …, C …>(
  ids: readonly string[],
  opts?: { with?: W; columns?: C },
): Promise<Array<AccountResult<W, C>>>;

list<W …, C …>(
  query?: ListOptions<typeof accounts> & { with?: W; columns?: C },
): Promise<Array<AccountResult<W, C>>>;

// one per `queries:` entry (plain by-column) and per `belongs_to` FK — same shape
findByOwnerId<W …, C …>(ownerId: string, opts?: { with?: W; columns?: C; limit?: number }): Promise<Array<…>>; // `limit` ⇒ ordered by id
findByEmail<W …, C …>(email: string, opts?: { with?: W; columns?: C }): Promise<AccountResult<W, C> | null>; // unique
```

- **`with` is emitted only where REL-2 §2.5 allows it** (the entity declares a non-transitive relationship). An entity
  with no relation still gets `columns` — the mask is a property of the table, not of the graph.
- **`via:` and `select:` finders keep their own shapes** (REL-2 §5.4: a projection or a junction join is a query, not a
  shape). They gain nothing here.
- **`TWith` / `TColumns` are inferred at the call site.** REL-2 §2.3's rule carries over unchanged: hoisting a mask or
  include into a `const` must be done without a type annotation (or `as const`).
- **Defaults keep the override assignable** to the base's non-generic `findById(id): Promise<TEntity | null>`, which
  `IBaseRepository` (and so `BaseService`) constrains on. With neither option the result is the plain row.

### 2.4 `findByIds` semantics (decided)

| Input | Result |
|---|---|
| `[]` | `[]`, **no statement issued** |
| duplicates `['a','b','a']` | each row **once** — the id set is de-duplicated before the query |
| order | rows returned in **input order of first occurrence** — `in (…)` does not preserve order, so the repository re-sorts; a caller wanting a lookup does `new Map(rows.map((r) => [r.id, r]))` |
| a missing id, a soft-deleted row, another tenant's row | **absent** from the result — identical, by design (tenant-context "Not-found semantics": no existence oracle). No `null` placeholders |
| a `columns` mask that omits `id` | still ordered: the statement selects `id` anyway and the key is stripped from each row before return, so the result type (no `id`) is the truth |
| an id spelled differently from the database (`'A0EE…'`, `'{a0ee…}'`, no hyphens on a `uuid` key; `'07'` on an integer key) | found, and de-duplicated against the canonical spelling: both sides are compared through `idKey`, which canonicalises by the key's SQL type — a `uuid` to lowercase hyphenated, an integer type to its integer text — and compares anything else as its text, so a `text` key distinguishes case (review #2, R-2, #859 Q-4). A returned row no input id claims **throws** in `inInputOrder` rather than being dropped — a spelling `idKey` does not canonicalise is loud, never lossy |
| `columns: { id: false }` — an exclusion mask whose only exclusion is `id` | no mask is sent (an empty `{}` would select no root column: Drizzle throws without `with`, and with one returns rows with no `id`); `id` is stripped after ordering. A row without `id` throws in `inInputOrder` rather than being dropped (review #1) |
| `[]` under `strict` with no requester context | **throws**, like any read: no statement is built, but `assertReadScope()` runs the scope's boundary checks first, so a missing boundary is not hidden by an empty input (#859 review) |
| a large id list | one `in ($1…$n)`; Postgres caps a statement at 65 535 parameters. Not chunked — chunking would silently become several statements (I4). Documented on the method |

`columns: {}` (an empty mask) is rejected **twice**: at compile time — `ReadOptions<W, C>` types the slot as
`C & NonEmptyMask<C>`, which demands an impossible key when `keyof C` is `never` (asserted by a `@ts-expect-error` in
the smoke's type tests) — and at runtime by `checkColumns`, which throws naming the repository for a mask built
dynamically. "Empty" is judged after dropping `undefined`-valued keys, which Drizzle ignores: `{ name: undefined }`
selects exactly what `{}` does, so it throws too, and an `undefined` key beside a real one is dropped from the mask
that is sent (#859 Q-7). It selects nothing at runtime and types as an empty object, which is never what a caller meant. Masks are inclusion (`{ a: true }`) or exclusion (`{ a: false }`) —
Drizzle's own rule, unchanged.

### 2.5 Designed for: return variants (not built)

`VARIANTS.md`-style return shapes (`related` / `short` / `detailed`) are named `{ columns, with }` literals generated
from the field tiers. They plug into this surface without changing it:

```ts
// emitted later, per entity, beside the repository
export const AccountVariants = { short: { columns: {…} }, detailed: { columns: {…}, with: {…} } } as const;
export type AccountVariant = keyof typeof AccountVariants;

// one more overload per method, emitted beside the generic one
findById<V extends AccountVariant>(id: string, opts: { variant: V }): Promise<AccountVariantResult<V> | null>;
// body: `const o = AccountVariants[opts.variant]` → the same execution path with `o.columns` / `o.with`.
```

What this spec guarantees so that is a small change later:
- `columns` and `with` are **the** two shape knobs and every read accepts both, so a variant is exactly one
  `{ columns, with }` value — no third knob to map;
- `<Entity>VariantResult<V>` is `<Entity>Result<(typeof AccountVariants)[V]['with'], …['columns']>` — `ResultOf`
  already takes both;
- `variant` and `columns`/`with` will be mutually exclusive at the type level (`{ variant: V; columns?: never;
  with?: never }`), so the overloads cannot be combined into an ambiguous call.
- the generated service forwards with explicit `<W, C>` type arguments, so each variant overload is mirrored in
  `service.ejs.t` too — mechanical, but two templates, not one;
- the HTTP surface (`?variant=short`) is a closed, server-defined shape, which is I6-compatible in the way a
  client-supplied `fields=` is not. Not specified here.

---

## §3 One execution path, one root filter

### 3.1 Decision: every generated read executes on RQBv2

The include path is not "the path a `with` takes" any more. Every read of the **read surface** — `findById`,
`findByIds`, `list` and every plain `queries:` / `belongs_to` finder, with or without options — runs as
`this.db.query.<table>.findFirst/findMany(config)`. The core `select().from()` builder (`baseQuery()`) stays for what is
not on that surface, and those reads are exceptions to "one path", listed so nobody reads the claim wider than it is:

- `count()` (no traversal, no shape) and the by-id write paths (`scopeAnd()`);
- the base's own default reads (hand-written repositories) and the family bases' bespoke reads;
- a `via:` / `select:` declarative finder (§2.3 — a join or a projection is a query, not a shape);
- the junction repository's finders (`templates/junction/new/repository.ejs.t`) and `relationship new`'s repository.

Each still scopes its root through `scopeAnd()` — the same `scopeAndOn` assembly `rootFilter` uses (§3.2) — so the
exceptions are a second *rendering*, not a second scope.

Why one path, and not "fix the include path's `where`":
- **The defect class is "a value rendered for one path, used on the other".** It has happened three times (root
  predicate, `orderBy`, caller `where`). With one path there is no second rendering to drift.
- **REL-2 Found #9 happened because a path was not exercised.** One path is exercised by every read, including every
  plain `findById` in every existing test.
- `columns`, `orderBy`, `limit`, `offset` and `where` are all native RQBv2 config. On the core builder a typed column
  mask would need its own projection builder and its own result typing — a second implementation of what RQBv2 does.
- RQBv2 exposes every table in the schema barrel, including tables with no relations (`db.query.<t>` exists; it just
  has no `with` slot). So the single path covers every entity.

Cost, measured in §10 as it lands: the plain read's SQL changes shape (`from "accounts" as "d0"` instead of
`from "accounts"`). Postgres plans both identically; REL-2 §1 and a host's `EXPLAIN ANALYZE` found the RQBv2
root subquery pruned to the selected columns. Baselines and the golden snapshot regenerate (I7).

### 3.2 The root filter is ONE base-class function

```ts
// BaseRepository — the only way a generated read builds its root predicate
protected rootFilter<T extends PgTable>(where?: RowFilter<T>): (t: T) => SQL;  // T inferred from the RAW slot (§10 Found #6)
```

It returns the `RAW` callback: `(t) => and(where?.(t), scopeFilter(t, scopeConfigFor({ softDelete }), owner)) ?? true`.
Every generated read uses it as its ENTIRE root `where` — `where: { RAW: this.rootFilter((t) => eq(t.id, id)) }`,
`(t) => inArray(t.id, unique)`, `(t) => and(eq(t.a, a), eq(t.b, b))` for a finder, `query?.where` for `list` — so a
read has exactly one root predicate and it is rendered on the alias (§10 Found #2 for why the key predicate is a row
filter rather than an RQBv2 object filter beside it). It **replaces** `rootScopeRawOn` (no parallel helper, I7). `orderByOn(t, sort)` stays and is
used the same way, inside an `orderBy: (t) => …` callback.

So the three call sites of REL-2 §3 become: `scopeAnd()` (core builder: base reads, count, by-id writes),
`rootFilter()` (every read-surface read), `hopScope()` (the manifest). All three are `scopeFilter`, and the first two
are one assembly: both call `scopeAndOn(table, extra, opts)` — `scopeAnd` with the repository's own table, `rootFilter`
with the aliased root — so "the caller's predicate AND the scope" is written once (#859 Q-3).

### 3.3 Root and hop, per method — the guarantee, as a table

| Method | Root | Hops |
|---|---|---|
| `findById` / `findByIds` / `list` / `findBy*` — any options | `rootFilter` → `scopeFilter(t, …)` on the aliased root | manifest `hopScope` on every relation traversed — via `with` (lateral) **and** via a relation filter (`EXISTS`) |
| `count(where)` | `scopeAnd()` → `scopeFilter(this.tableRef, …)` | — (no traversal) |
| hand-written `db.query.<t>` | **the caller's** — `rootScope.<t>(owner)` (§5) | manifest `hopScope` |

§8.2 asserts every cell of the first row against Postgres.

### 3.4 The generated class owns its read names — an override beneath it is refused, loudly

A generated repository defines `findById`, `findByIds` and `list` itself (and a `count` that only re-types and calls
`super`). So an override of one of those three on a class BETWEEN `BaseRepository` and the generated class — an app
pattern's base class, a capability mixin, a generated `<Entity>ComposedBase`'s mixins — can never run. The generated
service is the same: it forwards those three straight to the repository with their typed options, past any override
on a pattern's service base.

That must not be silent (decided 2026-11-12, §10 Found #10). The generated constructor calls
`this.claimGeneratedReads(<GeneratedClass>)` (`BaseRepository` and `BaseService` both carry it; the walk is
`assertGeneratedReadsOwned` in `runtime/base-classes/read-surface.ts`). It walks the prototype chain from the generated
class's parent down to the base, exclusive at both ends, and **throws at construction** if any class on it has its
own `findById` / `findByIds` / `list`, naming the method and the class:

```
AccountRepository: AuditedBase.findById overrides a read the generated AccountRepository defines itself,
so it would never run (READ-1 §3.4). The generated findById / findByIds / list own those names. To narrow which
rows EVERY read sees, override `scopeAndOn` …; to wrap a read, give the wrapper its own name or override it on a
subclass of the generated class.
```

Not checked, on purpose: `count` (the generated one calls `super`, so a base override runs); a SUBCLASS of the
generated class (its override runs — that is the ordinary way to wrap a generated read); and the family bases'
own `findBy*` methods, which a generated finder of the same name overrides by design. No runtime base or mixin
overrides the three names today, so the check fires only on project code.

Why loud, and not the two alternatives:
- **Shaped reads on the base, no generated override.** The typed signatures still cannot live on the base (REL-2
  §2.1's TS2536), so they would have to reach the class by interface merging, and a base/mixin override written as
  `findById(id)` would drop `columns` / `with` while the signature promised the shaped result — a silent shape lie
  instead of a silent bypass.
- **`super` when a non-base override exists.** Same lie (the override takes neither option), plus two execution
  paths chosen at runtime.

Both trade the silent bypass for a different silent defect. Refusing at construction is the only option where the
override neither runs wrongly nor vanishes.

---

## §4 `where` and `sort`: one safe shape

### 4.1 `ListOptions` is generic over the table, and `where` is a function of it

```ts
/** A row predicate as a FUNCTION of the table handle — so whichever path runs it can hand it the handle it holds. */
export type RowFilter<TTable extends PgTable> = (table: TTable) => SQL | undefined;

export interface ListOptions<TTable extends PgTable> {
  where?: RowFilter<TTable>;
  sort?: readonly SortTerm[];
  limit?: number;
  offset?: number;
}
```

- **`where: SQL` is gone.** A pre-rendered `SQL` names the real table; it is wrong on the aliased path and was only
  ever right on the core path by accident of not aliasing. There is no overload that accepts it — a pre-built `SQL`
  is a compile error (`TS2322`), asserted by a `@ts-expect-error` type test (§8.1).
- **`orderBy?: PgColumn | SQL` is gone** (the pre-rendered order, REL-2 Found #2). `sort` (column keys + directions)
  is the ordering; it renders on either path. Its only template use was the guard that threw when combined with
  `with`, which goes with it.
- `count(where?: RowFilter<TTable>)` takes the same shape, so the list use case passes **one** value to `list` and
  `count` and they cannot describe different sets.
- Generic **without a default** (I7, the REL-0/REL-2 reasoning): `ListOptions` with a default `PgTable` would let a
  `where` written against the wrong table compile.

Call sites move from `{ where: eq(accounts.name, x) }` to `{ where: (t) => eq(t.name, x) }`. Inside the generated
search use case, the capability predicates (`memberPredicate`) and the scaffold tests, every `where` becomes a function.
`WithActor.memberPredicate(actorId)` returns a `RowFilter` — its group form is an `EXISTS` correlated on the
**root's** `id`, so on the aliased path it must render against the alias too. (It was correct only because no caller
had combined it with `with` yet.)

### 4.2 The gate that keeps it from recurring

- **Type level:** `ListOptions['where']` has no `SQL` member (§8.1 negative test).
- **Shape level:** `no-untethered-raw-callback.test.ts` (REL-2), across `templates/`, `src/emitters/`, `runtime/` and
  the golden snapshot, bans:
  - a `RAW:` whose value is not a callback (`{ RAW: someSql }`, `{ RAW: callerWhere }`);
  - a zero-argument `rootFilter(() => …)`;
  - this repository's own handle — `this.table`, `this.tableRef`, `this.col(`, or the table export
    `<%= entityNamePlural %>.` — on a `rootFilter(` / `RAW:` line, **and anywhere in a `rootFilter(` argument**, read
    whole across lines by balanced parentheses (#859 review: a body continuing on the next line passed the line check);
  - a parenthesised non-callback value (`RAW: (callerWhere)`) — the value check requires an arrow;
  - a `RAW:` whose value is on the next line (the `RAW:` checks are line-based, so that shape is banned outright).

  Each was mutation-checked against the template (review #6's M1–M3 all go red in `just test-unit`). It is a grep:
  a spelling no pattern names can still pass, which is why the runtime gate below stays.
- **Runtime:** §8.2's integration test runs `list({ where, with })` on a scoped entity through a generated repository
  against Postgres — the test that would have caught #840, red before the fix.

---

## §5 Reading outside a repository: the exported scope (#843)

### 5.1 The manifest exports every entity table's `ScopeConfig`

```ts
// <generated>/relations.ts
export const ACCOUNTS_SCOPE = tableScope(schema.accounts, { tenantScoped: true, tenantColumn: 'tenantId', softDelete: true, … });
export const CONTACTS_SCOPE = tableScope(schema.contacts, { … });
…
/** Every ENTITY table's declared scope — unscoped tables included, explicitly. */
export const SCOPES = {
  accounts: ACCOUNTS_SCOPE,
  contacts: CONTACTS_SCOPE,
  opportunities: tableScope(schema.opportunities, UNSCOPED),
} as const satisfies Partial<Record<keyof typeof schema, ScopeConfig>>;
```

- Constants are `export`ed and emitted for **every entity table that declares any scope**, not only for hop targets (a
  table nothing points at still has a root). An entity with no scope maps to the runtime's `UNSCOPED` constant — an
  **absent key must not read as permissive** (CLAUDE.md gate rule (c)); a missing table is a type error at the
  `SCOPES.<t>` access, not a silent no-filter.
- Junction tables are not in `SCOPES` (they have no scope declaration; REL-2 §1.5).
- **`SCOPES` and `rootScope` are emitted on every project**, including one that scopes nothing (every entry
  `tableScope(schema.<t>, UNSCOPED)`). The first cut omitted both when no entity declared a scope, to keep an unscoped
  project's manifest byte-identical; review (#859) rejected that — byte-stability for a project that has no users is
  not a reason (CLAUDE.md), and the omission meant a loader written in an unscoped project could not name the root
  scope, so it stayed root-unscoped the day an entity became `tenant_scoped`. A project with no entities (`project
  init`) gets `SCOPES = {}` / `rootScope = {}` and imports nothing from the runtime.
- Every constant is a **`TableScope<T>`** — `tableScope(table, cfg)` returns the config with its table attached — so
  the table a scope describes travels with it in the type (§5.2).

### 5.2 The runtime helper

```ts
// runtime/base-classes/scope-filters.ts
export const UNSCOPED: ScopeConfig;
export type TableScope<T extends PgTable> = ScopeConfig & { readonly table: T };
export function tableScope<T extends PgTable>(table: T, cfg: ScopeConfig): TableScope<T>;
/** The root half of a scoped read, for code that calls `db.query.<t>` itself. */
export function scopedRoot<T extends PgTable>(scope: TableScope<T>, owner: string): { RAW: (t: T) => SQL };
```

`scopedRoot` takes a **`TableScope<T>`, never a bare `ScopeConfig`**, and infers `T` from it. The first cut was
`scopedRoot<T extends PgTable = PgTable>(cfg: ScopeConfig, …)`: `T` defaulted, nothing tied it to the config, and
`db.query.accounts.findMany({ where: scopedRoot(SCOPES.notes, 'x') })` compiled and read accounts with the notes
posture — the documented pairing was the unsafe one (#859 Q-1). Now the scope carries its table, so another table's
scope (or a bare `UNSCOPED`) is a compile error on any query — asserted by `@ts-expect-error`s in
`read-api-sql.spec.ts` (type-checked) and the smoke's type tests.

The manifest also emits the per-table factory, one per entity table (review #10):

```ts
export const rootScope = {
  accounts: (owner: string) => scopedRoot(SCOPES.accounts, owner),
  …
};
```

`db.query.contacts.findMany({ where: rootScope.accounts('x') })` is a compile error (a `@ts-expect-error` in the smoke's
type tests). `rootScope.<t>` is the documented form; `scopedRoot(SCOPES.<t>, owner)` is what it expands to, equally typed.

The posture is ONE derivation: `entityScope` folds the pattern-implied behaviors (`resolveImpliedBehaviors`), the same
helper the repository's `behaviors` come from — so an app pattern implying `soft_delete` filters deleted rows at the
repository root, every hop, `SCOPES` and `rootScope` alike (review #9). The manifest reads it through
`requireImpliedBehaviors`, which **throws** on a pattern this process never registered instead of skipping it, and
`regenerateRelationsManifest` loads the project's app patterns itself before deriving anything. Before that,
`relationship new` regenerated the manifest without loading them, so a pattern-implied behavior dropped out of every
hop, `SCOPES` and `rootScope` whenever that command ran last (#859 A-B1; `relations-generator-patterns.test.ts`).

```ts
// a loader outside any repository
await db.query.accounts.findMany({
  where: { AND: [{ id: { in: ids } }, rootScope.accounts('AccountLoader')] },
  columns: { id: true, name: true },
  with: { contacts: { columns: { email: true } } },
});
```

`scopedRoot` is `hopScope` shaped as a filter — the same `scopeFilter`, so the root a loader applies is the root a
repository applies (§3.2's one function). Repositories do **not** read `SCOPES`: their posture is the emitted
`behaviors` + `scopeEnforcement`, both from the same YAML declaration (I1 is "derive from the declaration", REL-2 §3).

### 5.3 Raw `db.query` — the rule, and how far it is enforced

**Rule:** *a read that calls `db.query.<table>` directly gets hop scoping from the manifest and root scoping from
nobody. Route it through a generated repository; if it cannot be (a cross-entity loader), its root `where` must AND
`rootScope.<table>(owner)`.*

Enforced:
- **inside this repository** — `src/__tests__/templates/no-unscoped-db-query.test.ts` scans `templates/`,
  `src/emitters/`, `src/cli/shared/` and `runtime/`: every `db.query.<t>.findFirst/findMany(` must be followed by
  `where: { RAW: this.rootFilter(` or be named in its allowlist with a reason (empty today), and a dynamic
  `db.query[…]` is banned. It asserts it reaches the six reads of the repository template, and that every allowlist
  entry still names a real hit. Mutation-checked: replacing `findById`'s root with `{ id: { eq: id } }` turns it red;
- **for consumers** — documented in the codegen consumer skill and in the manifest's own header. A generator cannot
  lint consumer code.

**Considered and deferred: a root-scoping client.** Wrapping `db.query.<t>.findFirst/findMany` (and `tx.query`) at the
emitted database module so every root read ANDs `SCOPES.<t>` would make root scoping structural for hand-written reads,
exactly as REL-2 §1.4 made hop scoping structural. It is the right end state for raw `db.query` reads (#844) and it is deferred because it
wraps Drizzle's query builders and transaction handles at runtime — a separate design (interaction with `withAllTenants`,
transactions, and repositories double-applying the root) that deserves its own spec. Filed as a follow-up (§11).

---

## §6 `withRequester` awaits inside the context (#842)

```ts
export function withRequester<T>(ctx: RequesterContext, fn: () => PromiseLike<T> | T): Promise<T> {
  return als.run(ctx, async () => await fn());
}
```

Resolving the callback's value **inside** `als.run` forces a lazy thenable's `.then` — and so the statement build, and
so every hop callback's ALS read — while the context is active. Every hatch (`withTenantScope`, `withAllTenants`,
`withUserScope`, `withOrgScope`, `withSuperuserScope`) routes through `withRequester` and is fixed with it. The
parameter widens to `PromiseLike<T> | T` because a Drizzle builder is a thenable, which is what callers hand it.

Generated repositories were never affected (their methods `await` internally); the fix is for use-cases and loaders
that return a builder.

---

## §7 Service, use-case and HTTP

- **Generated service** forwards the full options on `findById`, `findByIds`, `list` and **every** `queries:` /
  FK finder it exposes (fixing #5 of "Why"). Pure delegation, as REL-2 §7 requires; the signatures are the repository's.
- **List use case** keeps its `where` seam, now a `RowFilter`, and passes it to `list` and `count` unchanged.
- **HTTP is unchanged.** No `?columns=`: a client-chosen projection is the open-ended surface I6 forbids, and the
  closed alternative is variants (§2.5). `<Entity>ApiResult` stays the full row plus optional relations.

---

## §8 Tests that prove it

Every one is written to fail before its fix; §11 records the mutations that prove it.

### 8.1 Type tests (compile-time, consumer tsconfig posture)

In the smoke fixture's consumer usage file (compiled by `just test-smoke-relationship`, so it runs under the strict
consumer posture — I9's warning that `bun run typecheck` does not validate a runtime type change):

- exact result types, with `Equal<>` (not assignability): root mask only; mask + include; an include whose hop has its
  own `columns`; a 2-deep include with masks at both levels; `findByIds` with mask + include; `list` with mask; a
  `queries:` finder with mask;
- the defaults: `findById(id)` is exactly the row type;
- the named result type (§2.2, Found #10): `AccountResult` and `AccountResult<AccountNoInclude>` are exactly `Account`
  (the latter was `{}` with the mask first), `AccountResult<{ contacts: true }>` carries `contacts: Contact[]`,
  `AccountResult<AccountNoInclude, { id: true }>` is `{ id: string }`, and a mask in the include slot is a
  `@ts-expect-error`;
- negatives (`@ts-expect-error`, which TS2578 keeps honest): an unknown column in a mask; an unknown relation in `with`;
  reading a column the mask excluded; a pre-rendered `SQL` passed as `where`; `service.count(<SQL>)` and
  `service.list({ where: <SQL> })` (review #3); one table's `rootScope` on another table's query (review #10).
  (`with` on a relation-less entity is typed `ReadOptions<never, C>`; the CRM fixture has no relation-less entity,
  so that negative is not asserted.)

### 8.2 Runtime SQL — `just test-unit`, no Docker (`.toSQL()` on real statements)

Over a generated-shape repository (`read-api-sql.spec.ts`; it type-checks, using the manifest's conditional
`IncludeOf`) on a tenant + soft-delete entity, for **each** of `findById`, `findByIds`, `list`, a unique `queries:`
finder and an FK finder, with and without `columns` / `with` / `where`:
- the root predicate renders on the alias (`"d0"."tenant_id"`), never on the real name;
- the caller's `where` renders on the alias;
- the root `select` names exactly the masked columns (plus `id` for a `findByIds` that omitted it);
- each hop carries `hopScope`;
- §3.4: a pattern base class overriding `findById`, and a capability mixin overriding `list`, make construction throw,
  naming the method and the class; a mixin overriding only `count` constructs and its override runs; a subclass of the
  generated shape may override; the same on `BaseService`.

### 8.3 Integration — `just test-integration`, real Postgres

Extending REL-2's leak graph (`region` / `site` / `sensor`, every entity scoped):
- **R1** `list({ where, with })` on a scoped entity through a GENERATED repository executes and returns the right rows
  (#840 — red before);
- **R2** `findByIds` — order = input order, duplicates once, `[]` issues no statement (and still throws under `strict` with no context), a foreign / soft-deleted id is
  absent, a mask without `id` still orders;
- **R3** poison rows at root and at each hop are excluded on **every** method, with and without options;
- **R4** `scopedRoot(SCOPES.<t>)` (what `rootScope.<t>` expands to) on a hand-written `db.query` excludes the same root
  poison rows a repository does;
- **R5** a lazy thenable returned from `withRequester`'s callback runs inside the context (unit test with a hand-made
  thenable that reads the ALS in `.then`, plus a real `db.query` traversal under `strict`);
- **R6** (§3.4) a class with its own `findById` / `findByIds` / `list` spliced between the GENERATED `RegionRepository`
  and its base makes `new RegionRepository(db)` throw, naming both; one with its own `count` does not; the same for
  `findById` under the GENERATED `RegionService`. This is what proves the generated constructors make the call.

### 8.4 The host case, regenerated

A scratch regeneration of a host application's YAML (outside this repo — I10) through this branch's CLI: a page-by-ids
read — a page of ids, a root column mask, several to-one includes each with its own column mask — through the
GENERATED repository's `findByIds`, against a local database read-only. Asserted: **one** statement, the root and every
hop filtered on the tenant column, the root selecting exactly the mask, rows in input order. Reported in the PR, not
committed.

### 8.5 Mutation checks

Recorded in §11.

---

## §9 What REL-3 consumes (REL-2 §4, updated)

| Name | Shape |
|---|---|
| `<Entity>Columns` | `ColumnsOf<'<key>'>` |
| `<Entity>Include` | unchanged |
| `<Entity>Result<TWith, TColumns>` | `ResultOf<'<key>', TWith, TColumns>` — REL-2's `<Entity>Result<TWith>` unchanged; the mask is an optional second parameter |
| `findById` / `findByIds` / `list` / `findBy*` | `<W, C>(…, opts?: { with?: W; columns?: C })` |

The navigator accumulates an include tree and a root mask and calls one of these once (I4). Nothing else changes.

## §10 Found during implementation

### Found #1 — the mask's compile-time brand broke every cast on Drizzle 1.0.0-rc.5

`ReadOptions<W, C>.columns` is `C & NonEmptyMask<C>` (§2.4). Passing `opts?.columns` straight into `findMany` made
Drizzle infer its result from `columns: C & NonEmptyMask<C>`, a different deferred type from the `C` that
`<Entity>Result<W, C>` names. On **rc.4** (this repo's pin) the generated `rows as <Entity>Result<W, C>` still
type-checked; on **rc.5** every one was `TS2352: Conversion … may be a mistake`, in every generated repository. No gate
here could see it: every harness ran rc.4. Found by §8.4's scratch regeneration.

Fix: `checkColumns<C>(columns: (C & NonEmptyMask<C>) | undefined): C | undefined`, called with an EXPLICIT type argument
(`this.checkColumns<C>(opts?.columns)`) — inference alone kept the brand. The query config now carries plain `C` on
both pins. Recorded for the RC-bump checklist (DRZ-2 §A): **a Drizzle RC move must re-run a consumer regeneration, not
only the in-repo gates** — the in-repo pin is the one version consumers are least likely to be on.

### Found #2 — the key predicate is a row filter, not an RQBv2 object filter

The design ANDed `{ id: { eq: id } }` / `{ <col>: { eq: v } }` object filters beside `{ RAW: this.rootFilter() }`.
Built as `rootFilter((t) => eq(t.<col>, v))` instead, for two reasons: (1) an object filter's value is typed from the
column's data type, while a `queries:` finder's parameter is typed from the field's `tsType` — they differ for enum and
`choices:` columns, where `eq()` already accepted the parameter on the core path; (2) one root predicate per read is
the property §3.1 argues for, and the grep gates (`repository-template.test.ts` counts reads against `rootFilter`
calls) can then assert it exactly.

### Found #3 — the generated service dropped `opts` on `queries:` finders

`findByX(x)` forwarded only `x`, so REL-2's typed include on a declarative finder was unreachable from the service
layer — the layer use cases call. The service now forwards the full read options with the repository's generics on
every plain finder (`via:` / `select:` finders keep their own shapes).

### Found #4 — `memberPredicate` was correct only because nobody had combined it with `with`

`WithActor.memberPredicate`'s group form is an `EXISTS` correlated on the root's `id`, built against
`this.col('id')` — the un-aliased table. It worked on `baseQuery()`; on the relational path it would have been the
same FROM-clause error as #840. It now returns a `RowFilter`, correlated on the handle it is given.

### Found #6 — `rootFilter` is generic in its own table, not the class's

The first cut typed it `rootFilter(where?: RowFilter<TTable>): (table: TTable) => SQL`. Two failures, both only in a
repository composed through a capability mixin (`test-smoke-junction`'s `ledger`, 11 errors): the mixin's
`RepositoryCtor` sees the base as `BaseRepository<any, PgTable, …>`, so (1) a return type with `TTable` in a parameter
position made the concrete repository unassignable to it (contravariance), and (2) inside the composed class `TTable`
is `PgTable`, so `(t) => eq(t.id, id)` had no `id`. Now `rootFilter<T extends PgTable>(where?: RowFilter<T>):
(table: T) => SQL`, with `T` inferred from the RQBv2 `RAW` slot it is passed to — the concrete aliased table — so the
predicate is typed the same way in a bare spine and a composed one.

### Found #7 — review of #859, ten findings, all fixed here

| # | Finding | Fix |
|---|---|---|
| 1 | `findByIds(ids, { columns: { id: false } })` sent an empty mask: Drizzle threw, or with `with` returned `[]` | `byIdsColumns` sends no mask when `id` was the only exclusion; `inInputOrder` THROWS on a row without `id` |
| 2 | an uppercase / braced / unhyphenated uuid matched in SQL but was dropped by the JS re-order (base `findByIds` too) | `idKey` canonicalises a `uuid` key on both sides and in de-duplication; any other key is compared as `String(id)` — an integer key's `'7'` finds the driver's `7` (re-review R-2, unit test, mutation-checked) |
| 3 | `service.count(<SQL>)` compiled through `BaseService`'s `unknown` and threw at runtime | `BaseService.count(where?: Parameters<TRepo['count']>[0])`, concrete because the generated repository overrides `count` (Found #8); negatives in the type tests, cross-table on plain AND composed repositories. `IBaseRepository.count` stays `unknown` — it is the structural constraint, and a narrower function type fails strict variance. `BaseService.list` stays `unknown` because generated services override it with the typed signature; a HAND-WRITTEN service extending `BaseService` therefore keeps an untyped `list` (stated in the CHANGELOG) |
| 4 | Found #1's `checkColumns<C>` had no gate | `just test-baseline` typechecks the generated tree a SECOND time against `drizzle-orm@1.0.0-rc.5` (the `drizzle-orm-rc5` devDependency alias, types only; tsconfig derived from the baseline one at run time). Mutation: dropping `<C>` → TS2352 on rc.5, red. Plus a template test pinning `checkColumns<C>(` on every masked read |
| 5 | §5.3's `db.query` grep gate did not exist | written (§5.3) |
| 6 | the shape gate missed `rootFilter(() => eq(this.table.id, id))` (red only in Docker) | §4.2's extended bans; M1–M3 red in `just test-unit` |
| 7 | `activeParentFilter` was bound to the un-aliased table | `activeParentFilter(parentTable, fkKey: string): (table) => SQL`, correlated on the handle it is given; SQL test on the alias |
| 8 | the break table was incomplete | CHANGELOG + PR: vendored consumers run `codegen project update` first; every read needs `relations` on the client — and a repository now fails at CONSTRUCTION naming the cause (`requireRelationalQuery`); `withRequester`'s sync throw → rejection; the list use case's `where`; `rootScopeRawOn` → `rootFilter`; `activeParentFilter`. "The compiler finds every one" is replaced by which rows are compile errors and which are runtime |
| 9 | `entityScope` ignored pattern-implied behaviors, so `SCOPES` could disagree with the repository | folded through the implied-behaviors helper (§5.2); mutation-checked unit test |
| 10 | `scopedRoot` was untyped against its table | the manifest's `rootScope.<table>(owner)` (§5.2) — and, after the second review (Found #9), `scopedRoot` itself |

Re-review R-3 (the shape gates are line-based; a multi-line or aliased form passes `test-unit`, caught only by
the Docker job) is filed as #864. The rc.5 leg's derived tsconfig is removed on process exit and gitignored; the
build-graph test unregisters the pattern it registers.

Not fixed here, filed: the junction service's `listAssoc` dereferences a counterparty that scope filtered out
(pre-existing, #862), and `= any($1::uuid[])` instead of `in ($1…$n)` for large id lists (#863). An empty mask at a
HOP (`with: { owner: { columns: {} } }`) is not guarded at compile time; Drizzle throws `No fields selected` at runtime.

### Found #8 — a composed repository's `count` must be typed on the subclass

Typing `BaseService.count` from `TRepo` (review #3) failed the junction smoke's composed `ledger`: inside a capability
mixin written `return X as TBase & typeof X` (the app pattern's `WithAudited`, `capability-mixin.ts`'s example) the
repository's inherited `count` is typed over `PgTable`, and the strict `RowFilter<typeof ledgers>` did not fit it.

The first fix made `RowFilter` bivariant. Re-review (R-1) showed why that was wrong: at a site typed `RowFilter<PgTable>`,
EVERY concrete table is a sub/supertype pair, so ANOTHER table's filter compiled on the composed repository's and
service's `count` — and where column names coincide (`id`, `tenant_id`, `deleted_at`, …) it would count on the wrong
predicate. The negative that should have caught it was claimed but never landed (an unasserted edit no-op'd).

The fix that holds: `RowFilter` is the plain `(table: T) => SQL | undefined` again, and the generated repository emits
`override count(where?: RowFilter<typeof <table>>)` beside `list`, so `count`'s parameter is concrete on every
repository, composed or not, and the service's `Parameters<TRepo['count']>[0]` is concrete with it. Gated by:
- the junction smoke's custom-layout legs, which compile `ledger-read-api.type-test.ts` beside the COMPOSED ledger:
  own-table `count` / `list` on repository and service compile; another table's filter on each of the four is a
  `@ts-expect-error`. Mutation: removing the `count` override turns the leg red;
- the relationship smoke's cross-table negatives on a plain repository and service (`list`, `count`).

### Found #9 — second review of #859 (adherence + quality), all fixed here

| Finding | Fix |
|---|---|
| **A-B1** `relationship new` regenerated the manifest without loading app patterns, and the implied-behavior helper skipped an unknown pattern — so a pattern-implied scope dropped out of every hop, `SCOPES` and `rootScope` depending on which command ran last | `regenerateRelationsManifest` loads the app patterns itself (async; fails on a loader error); the graph builder reads `requireImpliedBehaviors`, which throws on an unregistered pattern; a missing entity definition throws instead of reading as UNSCOPED. `relations-generator-patterns.test.ts`, mutation-checked (dropping the load → red) |
| **A-B2** public-repo detail (I10) in the consumer skill, spec and PR body | fixture names in the consumer skill; host counts and pins removed from §8.4 / §10 / §11 and the PR body |
| `SCOPES` / `rootScope` absent when nothing is scoped | always emitted (§5.1) |
| **Q-1** `scopedRoot` accepted any table's scope | `TableScope<T>` + `tableScope()`; `scopedRoot` infers `T` from the scope (§5.2) |
| **Q-3** two owners of "scope AND predicate" (`rootFilter`, `scopeAnd`) | one `scopeAndOn(table, extra, opts)`; `scopeAnd` and `rootFilter` call it (§3.2) |
| **Q-4** an integer key compared as `String(id)` dropped `'07'` | `idKey` canonicalises integer types; `inInputOrder` throws on a returned row no input claims (§2.4) |
| **Q-5** `column()` / the list use case accepted `Object.prototype` names (`?sort_by=to_string` → `order by $1`) | `hasColumn` (own-key test) is the one check; `column()` and the list use case both ask it |
| **Q-6** `belongs_to` finders accepted and ignored `cursor`, and a `limit` had no order | `cursor` removed from the finder and the service's has-many composition; a `limit` orders by `id`. Keyset paging is not trivial here (no guaranteed ordering column), so it is not built |
| **Q-7** a mask of `undefined`-valued keys passed the key-count check | dropped before the check (§2.4) |
| `findByIds([])` under `strict` with no context returned `[]` | `assertReadScope()` runs the boundary check first (§2.4) |
| **A-N1** "every generated read runs on RQBv2" overstated | §3.1 lists the exceptions; the template comment, skill, CHANGELOG and PR body say "the read surface" |
| **A-N2 / A-N3 / A-N5** break-table gaps | A-N5: a CHANGELOG + PR row — pattern-implied scope makes a to-one include nullable and filters the hop. A-N2 (the generated overrides silently shadow a project's own base-class or mixin read override) and A-N3 (a stale one-argument `<Entity>Result<…NoInclude>` compiled to `{}`) were first recorded as break rows, then **designed away** (Found #10): the override is refused at construction, and the mask moved to the second parameter |
| Nits | the shape gate reads a multi-line `rootFilter(` argument and requires an arrow after `RAW:` (§4.2 — #864 still covers the AST version); the #813 lint counts type-only table imports, which caught the search use case's `where` and the service's `options` binding; `_unregisterLibraryPatternForTests` no longer splits `_resetRegistryForTests` from its JSDoc; the manifest comment says "below"; README and CAP-3 carry the `memberPredicate` row-filter revision |

### Found #10 — two approved design changes after the second review (2026-11-12)

Both apply the standing rule that a break is allowed only when it is how the design would be from scratch, and that a
silent break is the worst kind.

- **The mask is the SECOND parameter of `<Entity>Result` / `ResultOf` (A-N3).** The first cut put it first (`columns,
  with` — "the order the SQL is read in"). That broke REL-2's `AccountResult<W>`, and one form silently:
  `AccountResult<AccountNoInclude>` still compiled, because `NoInclude` fit the mask slot, and resolved to `{}`. With
  the include first and the mask an optional second parameter, every REL-2 spelling keeps its meaning, and a mask
  written in the first slot is a TS2559 (§2.2). Method generics, `ReadOptions` and the use cases follow the same order
  (§2.2), which also removed the use cases' `<undefined, TWith>` placeholder. Type tests: §8.1; mutation: §11.
- **A base or mixin override of a generated read is refused at construction (A-N2).** The generated repository's
  `findById` / `findByIds` / `list` (and the service's) silently bypassed a project's own override on a class beneath
  them. §3.4 records the check, what it exempts and why the two non-loud designs were rejected.

### Found #5 — smaller things fixed in passing

- `SortTerm` was declared twice in `base-repository.ts` (interface merging hid it). One declaration.
- A scoped project whose scoped entities are never hop targets would have imported `hopScope` unused into the
  manifest; the import is now conditional on a scoped hop existing, as `UNSCOPED`'s is on an unscoped entity.
- `withRequester` (and every hatch over it) takes `() => PromiseLike<T> | T` — a Drizzle builder is a thenable, and the
  narrower `Promise<T>` signature was what invited returning one un-awaited.

## §11 Acceptance

Gate output from the run made after the last code edit (`4d7f46a9`, all three review rounds included):

| Gate | Result |
|---|---|
| `just test-all` | **exit 0** — typecheck; `test-unit` 4417 pass / 3 skip (the `dist/`-gated singleton spec, unbuilt checkout) / 0 fail; `test-baseline` with BOTH typecheck legs (repo pin rc.4 and rc.5) passing with only the #680 expectation; every smoke PASS (default, subsystems ×2, relationship, junction ×4, junction-cross-domain ×2, capability ×2, integration, frontend); `test-junction` 12; `test-integration-emit` 56; `test-studio` 101; 47 expectations held |
| `just test-integration` (Docker) | **203 pass, 2 skip, 0 fail** — including `read-api.test.ts` R1–R5 |
| After Found #10 (2026-11-12): `just test-all` / `just test-integration` | **exit 0** — `test-unit` 4435 pass / 3 skip / 0 fail; both baseline typecheck legs with only #680; every smoke PASS; `test-junction` 12; `test-integration-emit` 56; `test-studio` 101; 47 expectations held. `test-integration` **205 pass, 2 skip, 0 fail** (R6a/R6b added) |
| Host case (§8.4), scratch regeneration on a second Drizzle RC | at `e3128c98` (not re-run after the second review): 0 `tsc` errors; the page-by-ids `findByIds` read: 1 statement, rows in input order, root + every hop on the tenant column |

**Mutations, each confirmed red and then reverted:**

| Mutation | Gate that goes red |
|---|---|
| render the caller's `where` on `this.table` in `rootFilter` | `test-integration` R1/R2 (`invalid reference to FROM-clause entry for table "regions"`, #840's error); every §8.2 alias test |
| `rootFilter` scope on `this.table` | every §8.2 alias test |
| revert `withRequester` to `als.run(ctx, fn)` | §8.2 lazy-thenable tests |
| a wrong `Equal<>` in the type tests | `test-smoke-relationship` (`TS2344`) |
| `this.checkColumns(` without `<C>` | `test-baseline`'s rc.5 leg (`TS2352`) |
| `rootFilter(() => eq(this.table.id, id))` in `findById` | `no-untethered-raw-callback.test.ts` |
| `findById`'s root as `{ id: { eq: id } }` | `no-unscoped-db-query.test.ts` |
| `entityScope` without the implied behaviors | `build-graph.test.ts` (review #9) |
| remove the generated `count` override | `test-smoke-junction` custom legs (composed ledger, re-review R-1) |
| `idKey` compares a non-uuid key as given | `read-api-sql.spec.ts` R-2 test |
| `regenerateRelationsManifest` without the app-pattern load (#859 A-B1) | `relations-generator-patterns.test.ts` (the graph builder throws on the unregistered pattern) |
| `idKey` compares an integer key as its text (#859 Q-4) | `read-api-sql.spec.ts` (`'07'` test) |
| the new §8.1 result-type assertions on the mask-first head (Found #10) | `test-smoke-relationship`: `AccountResult<AccountNoInclude>` is `{}` (TS2344), `{ contacts: true }` rejected (TS2559), the mask-in-include-slot `@ts-expect-error` unused (TS2578) |
| `assertGeneratedReadsOwned` returns without walking (§3.4) | `read-api-sql.spec.ts` §3.4 tests (3 red) |
| drop `this.claimGeneratedReads(…)` from the repository and service templates (§3.4) | `test-integration` R6a + R6b; `repository-template.test.ts` |

## §11a Issues

Filed with this spec (public tracker, host described by shape only):
- #840 — generated `list({ where, with })` renders the caller's SQL against the un-aliased root (§4);
- #841 — generated reads: root `columns` mask, and `findByIds(ids, { columns, with })` (§2);
- #842 — `withRequester` must await its callback inside the context (§6);
- #843 — export the manifest's per-entity scope, and a supported root scope for reads outside a repository (§5);
- #844 — follow-up (not built): a root-scoping query client (§5.3).

Follow-ups filed from the #859 review: #862 (junction `listAssoc` on a scope-filtered counterparty) and #863
(`= any($1::uuid[])` for large id lists).

Related, not in scope: #802 (reads take no `tx` — the read options object is where `tx` would go), #800 (filtered
entity over a base table), REL-3 #588.

## §12 Out of scope

- The variant emitter (§2.5 designs for it).
- Root scoping of hand-written `db.query` by construction (§5.3, follow-up).
- Read `tx` (#802), keyset cursors (the FK finder no longer takes a `cursor` it would ignore — #859 Q-6; the junction
  repository's `{ cursor?, limit? }` is unchanged and out of scope), `extras`, aggregation (I5).
- `optional: false` across a scoped hop (a to-one include typed non-null whose target can be filtered) — a separate
  finding, not a read-options question.
