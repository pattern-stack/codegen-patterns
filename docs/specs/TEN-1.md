# TEN-1 — ADR-042: ALS-fed repository tenant scoping

**Status:** **Shipped** — implemented 2026-09-20, PR against `dugshub/616-scope-guards`. Corrected below to
post-implementation truth: the gate's four decisions are recorded in §Decisions, and every §Open question is closed.
**Date:** 2026-09-17
**Issue:** #585 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-0 (#603), DRZ-2 (#584), GATE-2 (#604) · **Blocks:** REL-2 (#587)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §5A.2 ·
`docs/adrs/ADR-042-automatic-repository-tenant-scoping.md` (incl. its 2026-09-17 revision note) · ADR-044 §6 ·
`docs/specs/REL-0.md` (the typed repository this builds on) · `docs/specs/DRZ-2.md` §A1–A10

## Why

ADR-042 is Accepted and unimplemented. Generated entity repositories emit **zero** tenant filtering: the only ambient
scope `BaseRepository` understands is `userTracking` (`runtime/base-classes/base-repository.ts:370-389`), which filters
by `user_id`. Meanwhile four subsystems accept `multi_tenant: true` and enforce tenant *presence*, so a consumer who
flips that flag reasonably assumes isolation came with it. It did not.

ADR-044 turns the gap from "a missing feature" into "a blocker": relation traversal is the core read contract, and
**every hop** of a nested include must be tenant-scoped (charter I3, ADR-044 §6). A scope parameter cannot be threaded
through an include tree, so the ambient, repository-level mechanism is a **precondition** for REL-2 — hence the
ordering in PLAN §5A.2.

This spec implements ADR-042 §1–§7, plus the corrections in §"Found during design" below, which are the difference
between "isolation" and "isolation the generated code actually delivers".

## Charter invariants this PR touches

- **I3 scope at the repository, at every hop.** This is the whole PR. `tenant_scoped: true` defaults to
  `scopeEnforcement: 'strict'`: a missing context **throws**, it never reads unscoped. The predicate is designed as a
  function of `(table, tenantId)` so REL-2 can apply it per hop (§8).
- **I1 declare once.** One YAML flag (`tenant_scoped: true`) drives the column, the index, the behavior flag and the
  enforcement mode. Nothing introspects Drizzle to decide whether an entity is tenant-scoped; the decision travels as
  generated data (§8 carries it to REL-2).
- **I2 generated means regenerated.** All emission is template/complete-file. No hand-edited seam.
- **I7 no backwards compat.** `BehaviorConfig.tenantScoped` is a **required** field, not optional-with-default. There is
  no per-entity "lenient" opt-down for tenant scoping (§3.4) — the rollout reorders instead (§10). Hand-written
  `behaviors` literals in our own fixtures/scaffold are updated, not defaulted around.
- **I9 honest gates.** No new `any`, no `as unknown as`, no filtered error class, no scope carve-out. Every drizzle
  claim below was measured against the **installed** `drizzle-orm@1.0.0-rc.4` from inside the repo. `bun run typecheck`
  does not validate `runtime/base-classes/**` — `just test-smoke` is the gate for every runtime type change here.
- **I10 public repo.** No consumer/customer detail. §10 also **scrubs the named consumer out of ADR-042**, which is a
  pre-existing I10 violation in a file this PR must revise anyway.
- **I11 scope discipline.** `clean-lite-ps` only. A `tenant_scoped: true` entity under `generate.architecture: clean`
  is a **generation-time error** (§4.2) — the `clean` pipeline is known-red (#602); it is not fixed, not filtered, and
  not silently allowed to emit an unscoped repository.

## Measured facts

Measured on this branch against the installed `drizzle-orm@1.0.0-rc.4` (charter §8 risk: probe from **inside** the
repo). M1–M4 are code facts; M5–M6 are drizzle API facts that extend DRZ-2's A1–A10 checklist.

**M1 — the choke point is narrower than ADR-042 says: `count()` bypasses `scopeAnd()`.**
ADR-042 §"Insufficient injection points" claims `findById` / `findByIds` / `list` / `count` / `exists` are all covered
"via `baseQuery`". `count()` is not: it builds its own `select({count})` and assembles the soft-delete + scope
conditions by hand (`base-repository.ts:237-262`). It would have silently counted across tenants.

**M2 — every generated finder and every family finder DISCARDS the guard predicate.**
**Split out and fixed ahead of this spec: #616 / `docs/specs/SCOPE-0.md` (PR #619), which this branch now sits on.**
The measurement below is what SCOPE-0 was cut from; it is kept because it is the reason TEN-1's predicate is safe to
add at all. Two consequences for this spec: §3.5 ("the `.where()` override fix") is **already done** — TEN-1 no
longer touches those 17 sites — and §M1's `count()` finding is **also already fixed** there, so TEN-1's §3.2 keeps
only the `scopeAnd()` diff. SCOPE-0's control run recorded the pre-fix results: `findByExternalId` returned the row
owned by another user, and `findAllByUserId(USER_B)` returned 1 — the leaf predicate replaced the scope condition.
 `baseQuery()` returns a
`$dynamic()` builder that already has `.where(<guards>)` applied (`base-repository.ts:345-355`). Drizzle's
`.where()` **overwrites**: `select.js:548-554` is literally `this.config.where = where`. So every
`this.baseQuery().where(<leaf>)` throws the guards away — the exact footgun the method's own docblock warns about
(`base-repository.ts:340-343`). The sites, all of them:

| File | Sites |
|---|---|
| `templates/entity/new/clean-lite-ps/repository.ejs.t` | `:178`, `:183` (declarative finders), `:206` (FK traversal) |
| `templates/junction/new/repository.ejs.t` | `:84`, `:100` |
| `templates/relationship/new/repository.ejs.t` | `:38`, `:43` |
| `runtime/base-classes/activity-entity-repository.ts` | `:79`, `:88`, `:97`, `:107` |
| `runtime/base-classes/metadata-entity-repository.ts` | `:55`, `:69`, `:78` |
| `runtime/base-classes/integrated-entity-repository.ts` | `:35`, `:46`, `:55` |

This is a **live** soft-delete and `userTracking` defect today (`findByEmail()` returns soft-deleted rows and other
users' rows), and it would make TEN-1's central claim false: `findByX()` on a tenant-scoped entity would read every
tenant. Fixing it is not optional scope creep — it is the difference between shipping isolation and shipping the
appearance of it. (`templates/entity/new/backend/database/repository.ejs.t` has the same shape in 9 places; it is the
`clean` pipeline and has its **own** private `baseQuery()` — out of scope, #602, I11.)

**M3 — `clean-lite-ps` emits no single-column uniqueness at all,** so ADR-042 §5(c)'s premise does not hold for the
pipeline in scope. `.unique()` is emitted only by `templates/entity/new/backend/database/schema.ejs.t` (the `clean`
pipeline). In `clean-lite-ps`, field-level `unique: true` reaches the locals (`prompt.js:829`) and is emitted
**nowhere**; `queries: { by:[x], unique: true }` only shapes the finder's return type (`prompt-extension.js:755`,
`:794`). The only unique constraints `clean-lite-ps` emits are top-level `unique_indexes:` (schema-enforced 2+ columns,
`entity-definition.schema.ts:951-960` → `processUniqueIndexes`, `prompt-extension.js:601-609`) and the synthesized
`uniqueIndex('uq_<table>_provider_external_id').on(t.provider, t.externalId)` for `external_id_tracking`
(`prompt-extension.js:1300-1310`). §4.4 rules on both; there is no "suppress the bare per-field `.unique()`" work.

**M4 — `jobRuns` has `tenantId` but no `userId`.** `tenantId: text('tenant_id')`
(`runtime/subsystems/jobs/job-orchestration.schema.ts:137`) — **`text`, not `uuid`**. And there is no `userId` column
on `job_run` (verified against the full column list, `:120-160`), so ADR-042 §6's `claimed.userId ?? SYSTEM_USER` has
no `claimed.userId` to read. §6 rules on both.

**M5 — `uniqueIndex()` has no `.nullsNotDistinct()` on 1.0.0-rc.4; `unique()` does.**
`pg-core/indexes.d.ts` `IndexBuilder` exposes only `concurrently()` / `with()` / `where()`. `NULLS NOT DISTINCT` lives
on the table-constraint builder: `unique(name).on(...cols).nullsNotDistinct()`
(`pg-core/unique-constraint.d.ts`, `UniqueConstraintBuilder.nullsNotDistinct()`). This matters because the tenant
column is nullable-first (ADR-042 §7) and Postgres treats NULLs in a unique index as distinct — a
`(NULL, provider, external_id)` conflict target would never fire, and the integration upsert would insert duplicate
rows for null-tenant work instead of updating. §4.4 uses `unique(...).nullsNotDistinct()` for exactly this case.

**M6 — `getColumns(table)[name]` is `PgColumn | undefined` and `col()` throws on a miss** (REL-0 §M3, §3;
`base-repository.ts:44-50`, `:186-188`). A `tenantScoped: true` repository whose table has no `tenant_id` therefore
fails loudly at the first scoped statement — it cannot render a filterless query. This is the runtime backstop for
§4.2's generation-time guards.

## Found during design — corrections to ADR-042

Recorded here and folded into a dated ADR revision note in the implementing PR (§10).

1. **`count()` is not covered by the choke point** (M1). ADR-042 §"Insufficient injection points" is wrong about it.
2. **The finders discard the guards** (M2). ADR-042 §5(c) asserts "the finder already calls `baseQuery()` … so once
   `tenantScoped` is in `BehaviorConfig` the tenant predicate is AND-ed in with no template change". It is not, and the
   template change is mandatory.
3. **§5(c)'s composite-unique rewrite has nothing to rewrite in `clean-lite-ps`** (M3).
4. **§6's `claimed.userId` does not exist** (M4), and `jobRuns.tenantId` is `text` while the entity column is `uuid`.
5. **§6's ALS entry, taken literally, would newly scope `userTracking` repos to a sentinel user inside every job** —
   today a job runs with no ambient context, so a lenient `userTracking` repo is unscoped; entering
   `withRequester({ userId: SYSTEM_USER })` would filter `user_id = '<sentinel>'` and silently return nothing. §6
   enters with `scope: 'superuser'` on the user axis instead.
6. **The two escape hatches (§"Open follow-ups" 1) need a context field, not just a wrapper.** `runUnscoped` cannot be
   expressed by clearing `tenantId`, because under strict an absent tenant throws. §1 adds `tenantScope`.
7. **ADR-042 names the driving consumer throughout** — an I10 violation in a public repo. §10 scrubs it.

## Design

### 1. The ALS — `runtime/base-classes/tenant-context.ts`

```ts
export interface RequesterContext {
  readonly userId: string;
  readonly organizationId: string | null;
  readonly scope?: RequesterScope;
  readonly orgUserIds?: readonly string[];
  /**
   * The tenant this request acts within. Three states:
   *   string   → scope every read/write to this tenant.
   *   null     → the null-tenant PARTITION (system / cross-tenant rows):
   *              filters `IS NULL`, stamps NULL on create. Not a wildcard.
   *   absent   → no tenant established. lenient → unscoped; strict → throw.
   */
  readonly tenantId?: string | null;
  /**
   * Tenant-axis visibility, the counterpart of `scope` on the user axis.
   *   'tenant' (default) → apply the tenant predicate.
   *   'all'              → drop it (cross-tenant tooling). Reads see every
   *                        tenant; WRITES must supply `tenantId` explicitly or
   *                        `stampTenant()` throws (§3.3).
   */
  readonly tenantScope?: 'tenant' | 'all';
}
```

```ts
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(public readonly owner: string) { /* names the repository */ }
}

/** Read the ambient tenant. Strict never returns `undefined` — it throws. */
export function getTenantId(
  enforcement: 'lenient' | 'strict',
  owner: string,
): string | null | undefined {
  if (enforcement !== 'strict') return tryGetRequester()?.tenantId;
  const ctx = requireRequester();                    // no context → throws
  if (ctx.tenantId === undefined) throw new MissingTenantIdError(owner);
  return ctx.tenantId;                               // string | null
}
```

The three-state contract is the jobs one verbatim (`runtime/subsystems/jobs/jobs-errors.ts:80-103`): a resolvable
string passes; an **explicit** `null` passes and selects the null partition; an **absent** tenant under strict throws.
Note the second throw site: `requireRequester()` covers "no context at all", `MissingTenantIdError` covers "a context
that forgot the tenant" — which the ADR's `getTenantId` sketch would have let through as `undefined`, i.e. an unscoped
read under strict. That is the single most dangerous line in the ADR and it is fixed here.

A `MissingTenantIdError` class already exists in the jobs subsystem. It is **not** reused: jobs must not be a
dependency of `base-classes` (the arrow points the other way — `auth` already imports `base-classes/tenant-context`,
`auth/guards/authenticated.guard.ts:35`), and the two carry different payloads (a job method name vs. a repository
name). Two same-named errors in two subsystems is acceptable; one upward dependency edge is not.

**Escape hatches**, named to match the existing `withUserScope` / `withOrgScope` / `withSuperuserScope` family
(`tenant-context.ts:147-175`) rather than the ADR's working names `withTenant` / `runUnscoped` — the ADR's follow-up 1
explicitly delegates naming to implementation, and `withTenant` would collide with the repository's stamp helper:

```ts
/** Run `fn` acting within `tenantId` (or the null partition). Requires an outer context. */
export function withTenantScope<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T>;
/** Run `fn` across ALL tenants — super-admin tooling, tenant resolution at signup. */
export function withAllTenants<T>(fn: () => Promise<T>): Promise<T>;
```

Both are `withRequester({ ...requireRequester(), … }, fn)` one-liners. All four new symbols are exported from
`runtime/base-classes/index.ts`.

### 2. `BehaviorConfig`

```ts
export interface BehaviorConfig {
  timestamps: boolean;
  softDelete: boolean;
  userTracking: boolean;
  tenantScoped: boolean;   // REQUIRED — no optional default (I7)
}
```

Required, so every literal is forced to state its posture. Updated in the same PR: `BaseRepository`'s own default
(`base-repository.ts:144-148`), the clean-lite-ps / junction / relationship templates, the `src/__tests__/runtime/…`
specs, and `test/scaffold/tests/*.test.ts`'s hand-written repos.

### 3. `BaseRepository` — `runtime/base-classes/base-repository.ts`

#### 3.1 A predicate that is a pure function of `(table, tenantId)`

```ts
/**
 * Tenant predicate for ANY table. A free function, not a method, because
 * REL-2 must apply it per hop of an include tree (§8).
 *   undefined tenantId → undefined (lenient, no context) — caller decides.
 *   null              → IS NULL   (the null-tenant partition)
 *   string            → = tenantId
 */
export function tenantPredicateFor(
  table: PgTable,
  tenantId: string | null | undefined,
  owner: string,
): SQL | undefined {
  if (tenantId === undefined) return undefined;
  const col = column(table, 'tenantId', owner);      // throws when absent (M6)
  return tenantId === null ? isNull(col) : eq(col, tenantId);
}
```

and on the class:

```ts
protected tenantPredicate(): SQL | undefined {
  if (!this.behaviors.tenantScoped) return undefined;
  if (tryGetRequester()?.tenantScope === 'all') return undefined;   // withAllTenants
  return tenantPredicateFor(
    this.tableRef,
    getTenantId(this.scopeEnforcement, this.constructor.name),
    this.constructor.name,
  );
}
```

`this.tableRef` (REL-0 §2), not `this.table`: inside the base class `TTable` is a naked type parameter and the drizzle
builders do not resolve against it (REL-0 §M1). The concrete `TTable` is not needed here — the tenant column is reached
by key through `getColumns`, which is checked (`PgColumn | undefined`) and throws on a miss. It is REL-2's typed `with`
include that needs `TTable`, not the predicate.

#### 3.2 The three read/write choke points

```diff
 protected scopeAnd(extra?: SQL, opts?: { softDelete?: boolean }): SQL | undefined {
   const conditions: SQL[] = [];
   if (opts?.softDelete) conditions.push(isNull(this.col('deletedAt')));
   const scope = this.scopePredicate();
   if (scope) conditions.push(scope);
+  const tenant = this.tenantPredicate();
+  if (tenant) conditions.push(tenant);
   if (extra) conditions.push(extra);
   …
 }
```

`baseQuery()` / `update()` / `delete()` inherit it unchanged. `count()` (M1) stops hand-assembling its conditions and
calls `this.scopeAnd(where, { softDelete: this.behaviors.softDelete })` — identical semantics today, and it can no
longer drift from `scopeAnd` tomorrow.

#### 3.3 `create()` stamps

```ts
protected stampTenant(input: Record<string, unknown>): Record<string, unknown> {
  if (!this.behaviors.tenantScoped) return input;
  if (input['tenantId'] !== undefined) return input;          // explicit wins
  const ctx = tryGetRequester();
  if (ctx?.tenantScope === 'all') throw new MissingTenantIdError(this.constructor.name);
  const tenantId = getTenantId(this.scopeEnforcement, this.constructor.name);
  return { ...input, tenantId: tenantId ?? null };
}
```

Called from `create()` (`base-repository.ts:279-286`), wrapping `withTimestamps` exactly as ADR-042 §3 shows. Named
`stampTenant`, not `withTenant`, to leave `withTenantScope` unambiguous (§1). The `tenantScope: 'all'` throw is the
fail-closed half of the escape hatch: cross-tenant tooling may *read* every tenant, but it may not *write* a row
without saying which tenant owns it.

`update()` / `delete()` need no change: they already route through `scopeAnd(eq(id))`, so a cross-tenant write matches
zero rows — the same "returns null/[] — identical to truly doesn't exist" semantics the ALS doc already documents
(`tenant-context.ts:33-37`). No existence oracle leaks.

#### 3.4 `scopeEnforcement: 'strict'` is the default for tenant-scoped entities

**This is the one place this spec deliberately goes beyond ADR-042.** The ADR keeps `'lenient'` as the default so that
flipping `tenant_scoped: true` is non-breaking. Charter I3 overrides that: *"A missing context throws; it never reads
unscoped."* A lenient tenant-scoped entity is precisely "reads the union of all tenants when the boundary is missing" —
which is the failure this feature exists to prevent, and a silent one.

So: the repository template emits `protected override readonly scopeEnforcement = 'strict' as const;` whenever
`tenant_scoped: true`. There is **no opt-down knob** (I7 — an opt-down is a backwards-compat shim for consumers we do
not have). The base-class default stays `'lenient'` for `userTracking`-only repositories, which are unaffected.

Two consequences to state plainly:

- **The same knob governs the user axis.** A tenant-scoped entity that *also* declares `user_tracking` becomes strict
  for `userTracking` too. That is correct — both axes read the same ALS, and a missing boundary is a missing boundary —
  but it is a behavior change for such an entity, and it is why a second `tenantEnforcement` knob was considered and
  rejected (two knobs over one context is a distinction without a difference).
- **ADR-042 §7's rollout order changes.** Steps become: (1) install the boundary that supplies `tenantId`;
  (2) flip `tenant_scoped: true`, regen, additive `ADD COLUMN tenant_id uuid` (nullable); (3) backfill; (4)
  `SET NOT NULL`. The old step order ran 1–2 under lenient, which no longer exists. Recorded in §10.

#### 3.5 The `.where()` override fix (M2)

Every `this.baseQuery().where(X)` becomes `this.baseQuery(X)` — 10 runtime sites and 7 template sites (the M2 table,
minus the `clean` pipeline). Purely mechanical; `.orderBy()` / `.limit()` keep chaining off the returned builder.

Hardening so it cannot come back: a unit test in `src/__tests__/templates/no-basequery-where.test.ts` asserting that no
file under `templates/**` or `runtime/**` matches `baseQuery()` followed by `.where(` — the same shape as DRZ-1's
`no-v1-relations-emission.test.ts`. A type-level guard (`baseQuery()` returning `Omit<…, 'where'>`) was considered and
**rejected**: it is not airtight (`.limit().where()` still compiles), and `Omit` over the `PgSelectKind` builder risks
the `RowsOf` inference REL-0 measured generated code depends on.

While at line `repository.ejs.t:206`, the FK-traversal body's `(q as any).limit(...)` is replaced with
`q.limit(opts.limit) as typeof q` — post-REL-0 it type-checks, and I9 says no new or surviving gratuitous `any` on a
line this PR is already editing.

### 4. Generation — `clean-lite-ps` only

#### 4.1 The flag

`src/schema/entity-definition.schema.ts`, alongside the other top-level flags (`api`, `eav`, `unique_indexes`,
`:830-960`):

```ts
tenant_scoped: z.boolean().optional().default(false),
```

Threaded exactly as `definition.eav` is (`prompt-extension.js:1124`): `const tenantScoped = definition.tenant_scoped === true;`
returned in the clean-lite-ps locals next to `hasUserTracking` (`prompt-extension.js:1544-1548`).

It is **not** a `behaviors:` entry. Behaviors are declared twice today (`src/behaviors/*` and
`templates/entity/new/prompt.js:80-110`); a top-level flag has one declaration site and matches how ADR-042 specifies it.

#### 4.2 Generation-time guards — fail loud, never emit an unscoped repository

Three places a `tenant_scoped: true` entity could emit a repository that claims isolation it does not have. All three
throw with a message naming the entity and the reason:

| Guard | Where | Why |
|---|---|---|
| `generate.architecture !== 'clean-lite-ps'` | `templates/entity/new/prompt.js` (it resolves `architectureTarget` at `:1024-1026`) | the `clean` pipeline emits no tenant column, has its own private `baseQuery()`, and is known-red (#602). I11. |
| junction YAML declaring `tenant_scoped` | already rejected — `JunctionDefinitionSchema` is `.strict()` (`src/schema/junction-definition.schema.ts:113`) and has no such key. Asserted by a unit test so it stays true. | junction scoping is §11 out-of-scope |
| an entity with `tenant_scoped` **and** a `pattern`/family whose conflict-target write path is not covered | `prompt-extension.js`, if §5 is cut at review | see §5 |

**"How is an entity without the column prevented from declaring `tenant_scoped`?"** Within the generated pipeline it
cannot happen: the *same* flag emits the column (§4.3) and the behavior flag (§4.5), from one source (I1). The
divergence cases are (a) the wrong pipeline — the first guard above, at generation time; and (b) a hand-written
repository setting `tenantScoped: true` over a table with no `tenant_id` — caught at runtime by `col()`'s throw (M6),
at the first scoped statement, before any SQL is issued. There is no third case.

#### 4.3 The column

`templates/entity/new/clean-lite-ps/entity.ejs.t`, in the behavior-fields region (next to the `hasTimestamps` /
`hasSoftDelete` blocks, `:54-60`):

```ejs
<%_ if (tenantScoped) { _%>
    tenantId: uuid('tenant_id'),
<%_ } _%>
```

Nullable, per ADR-042 §7 step 2 (an additive `ADD COLUMN` on an existing table; the consumer tightens to `NOT NULL`
after backfill). `uuid` per ADR-042's "Neutral" note. `uuid` is already in the import set unconditionally
(`collectDrizzleImports`, `prompt-extension.js:617`), so no import change.

Plus an index — every scoped read filters on it:

```
index('<table>_tenant_id_idx').on(t.tenantId)
```

prepended to `clpTableConstraints` (`prompt-extension.js:1300-1310`), with `'index'` added to `extraDrizzleImports`
(`:1334-1336`).

**Known mismatch (M4):** `jobRuns.tenantId` is `text`. A job whose persisted tenant is not a UUID will fail the
`eq(uuidCol, '<not-a-uuid>')` comparison at Postgres with an invalid-input error. That is fail-loud, not a leak, and
it is documented in §12 rather than papered over by widening the entity column to `text`.

#### 4.4 Uniqueness (M3, M5)

- **Field-level `unique: true` / `queries: unique: true`** — nothing to do. `clean-lite-ps` emits no single-column
  unique constraint (M3). ADR-042 §5(c)'s rewrite is a correction, not a task. A unit test asserts a `tenant_scoped`
  entity with a `unique: true` field emits no bare unique.
- **Top-level `unique_indexes:`** — `processUniqueIndexes` (`prompt-extension.js:601-609`) prepends `tenant_id` to each
  entry's column list when `tenantScoped`, and the default name becomes `<table>_tenant_id_<cols>_uniq`. An
  author-supplied `name` is preserved. Without this, two tenants cannot hold the same natural key, which is the exact
  failure ADR-042 §5(c) is about.
- **`external_id_tracking`'s synthesized unique** (`prompt-extension.js:1305-1309`) becomes, when `tenantScoped`:

  ```ts
  unique('uq_<table>_tenant_provider_external_id')
    .on(t.tenantId, t.provider, t.externalId)
    .nullsNotDistinct(),
  ```

  `unique(...)`, not `uniqueIndex(...)`, because only the constraint builder carries `nullsNotDistinct()` on rc.4 (M5)
  and the tenant column is nullable — without `NULLS NOT DISTINCT` a null-tenant `ON CONFLICT` would never match and
  the integration upsert would duplicate rows instead of updating them. `'unique'` joins the import set.

#### 4.5 The repository

`templates/entity/new/clean-lite-ps/repository.ejs.t`:

```diff
-<% if (hasTimestamps || hasSoftDelete || hasUserTracking) { -%>
+<% if (hasTimestamps || hasSoftDelete || hasUserTracking || tenantScoped) { -%>
   protected override readonly behaviors: BehaviorConfig = {
     timestamps: <%= !!hasTimestamps %>,
     softDelete: <%= !!hasSoftDelete %>,
     userTracking: <%= !!hasUserTracking %>,
+    tenantScoped: <%= !!tenantScoped %>,
   };
+<% if (tenantScoped) { -%>
+
+  // ADR-042 / TEN-1 — tenant-scoped entities are strict: a missing ambient
+  // tenant throws rather than reading the union of all tenants (charter I3).
+  protected override readonly scopeEnforcement = 'strict' as const;
+<% } -%>
```

Both guard conditions (`:46` for the `BehaviorConfig` type import and `:102` for the literal) gain `|| tenantScoped`,
so a tenant-scoped-but-otherwise-behaviorless entity still emits the literal. Same two edits in the junction and
relationship repository templates for the `tenantScoped: false` field only (they are not tenant-scopable in v1).

### 5. The conflict-target write paths

**Shipped in full — the gate ruled it IN (§Decisions 1).** §5.3's fallback was not taken; it survives below only as
the record of what the alternative was.

An `ON CONFLICT` upsert is not covered by `scopeAnd()`. Left alone with a tenant-scoped entity, tenant B's integration
sync would **UPDATE tenant A's row** whenever the two share an `external_id` — an active cross-tenant write, strictly
worse than a read leak. The affected paths are all ours, in `runtime/base-classes/`:

#### 5.1 `IntegratedEntityRepository` (`integrated-entity-repository.ts`)

| Site | Change |
|---|---|
| `integrationUpsertOne` insert `:124-130` | `values` goes through `this.stampTenant(values)`; `cfg.conflictTarget` is prefixed with `'tenantId'` when `behaviors.tenantScoped` (matching the §4.4 constraint). `set` already excludes the identity columns, and `tenantId` is never in `writeColumns`, so a conflicting row's tenant is never rewritten. |
| `findByExternalIdProjected` raw select `:160-170` | `.where(this.scopeAnd(and(provider, externalId)))` — `scopeAnd` **without** `{ softDelete }`, preserving today's behavior (the differ must still see soft-deleted rows) while adding the tenant + user guards. |
| `softDeleteByExternalId` raw update `:188-200` | same `scopeAnd(...)` treatment. |
| `integrationUpsert`'s re-read `:220-226` | `.where(this.scopeAnd(eq(this.col('id'), id)))`. |
| `resolveFk` select on the **parent's** table | **partially** changed. A `refTable: 'self'` resolver now routes through `scopeAnd()` — that table IS this repository's, so a tenant-scoped hierarchy cannot resolve a parent in another tenant. A CROSS-TABLE resolver is still unscoped and cannot be fixed here: whether the parent entity is tenant-scoped is a fact about the parent's YAML, and recovering it from the parent table's columns is the I1 violation §8.3 forbids. Filed as **#702**, to land with REL-1's manifest. The residual is a dangling cross-tenant FK, not a read leak: the child row is still written in the caller's tenant and still reads back scoped. |

`clpIntegrationConfig.conflictTarget` emits `['tenantId', 'provider', 'externalId']` when `tenantScoped`, so
generated config and runtime agree without runtime introspection (I1). `buildIntegrationSurface` gained a trailing
`tenantScoped = false` parameter to carry it.

**Added during implementation:** the prefix is also applied at runtime, by a new protected
`conflictTarget(declared)` on `IntegratedEntityRepository`. The generated config is the declaration; the helper is
the backstop that makes a hand-written `integrationConfig` safe too. It never double-prefixes, so the two agree
rather than compounding.

#### 5.2 `MetadataEntityRepository.upsertMany(inputs, tx, { conflictTarget })` (`metadata-entity-repository.ts:22-49`)

The conflict target is a single caller-supplied column, and the unique index backing it is author-declared. Prepending
`tenantId` would break `ON CONFLICT` inference against that index. So when `behaviors.tenantScoped` and a
`conflictTarget` is supplied, it **throws**. The `conflictTarget`-less path delegates to `create()` and is already
covered. The same ruling applies to the generated EAV `upsertCurrentValues` override: `eav_value_table: true` +
`tenant_scoped: true` is a generation-time error in v1, raised from `buildCleanLitePsLocals`.

**As built**, the throw is a plain `Error` with a message naming the two ways forward and **#703**, not a
`MissingTenantIdError`. That class says "no tenant in the ambient context", which is not what happened here — the
context is fine; the *conflict target* is the problem. Reusing it would have made the error lie about its cause.

#### 5.3 The alternative, not taken

Had §5 been cut, `tenant_scoped: true` combined with `pattern: Integrated` / `external_id_tracking` /
`eav_value_table` / `MetadataEntityRepository` would have become a blanket generation-time error. The gate ruled §5
in, so only the two paths that genuinely cannot be made safe keep that treatment: `eav_value_table` (generation
error) and `upsertMany(conflictTarget)` (runtime throw). `pattern: Integrated` — the dominant adoption shape — works.

Shipping the combination silently was never on the table, and is not.

### 6. Jobs enter the ALS from the run's tenant (ADR-042 §6)

`runtime/subsystems/jobs/job-worker.ts:684` — the handler call inside `processRun`:

```diff
-const output = (await handler.run(ctx)) as Record<string, unknown> | undefined;
+const output = await withRequester(
+  {
+    userId: SYSTEM_ACTOR_ID,
+    organizationId: null,
+    scope: 'superuser',      // the user axis: a job is not a user (Found #5)
+    tenantId: claimed.tenantId,
+  },
+  () => handler.run(ctx) as Promise<Record<string, unknown> | undefined>,
+);
```

Three rulings, all corrections to ADR-042 §6 (M4, Found #4/#5):

- **`userId`.** `job_run` has no `userId` column, so there is nothing to read. A sentinel `SYSTEM_ACTOR_ID` constant
  ships in `tenant-context.ts` and is used for the audit-trail field. A job that acts on behalf of a user carries that
  user in its own `input` and installs a narrower context itself.
- **`scope: 'superuser'`.** Without it, entering the ALS would newly scope every `userTracking` repository inside every
  job to the sentinel user — i.e. every such read silently returns nothing where today it returns everything. A job is
  a tenant-level actor, not a user-level one: the tenant axis scopes, the user axis does not.
- **`claimed.tenantId` is `string | null`.** Both states are meaningful and both are *present*: a tenant's job scopes to
  that tenant, a cross-tenant housekeeping job (`tenant_id = NULL`) scopes to the null partition. Neither is `undefined`,
  so a strict tenant-scoped repository inside a job never throws for want of a boundary.

`runtime/subsystems/jobs` already depends on `runtime/base-classes` in the same direction as `auth` does, so the import
is an existing edge, not a new one.

### 7. The HTTP boundary — no change required

`resolveRequesterContext` passes the consumer's `IUserContext.resolveRequester(req)` result through **verbatim**
(`runtime/subsystems/auth/middleware/requester-context.ts:69-80`), so adding `tenantId` to `RequesterContext` makes it
flow end to end with zero middleware change. Two facts to document, not to code around:

- The `getCurrentUserId` **fallback** builds `{ userId, organizationId: null }` with no tenant. Under strict that
  throws downstream — correct and fail-closed. A consumer using `tenant_scoped` must implement `resolveRequester`.
- `onUnresolved: 'unscoped'` (the default) lets an unauthenticated request proceed with **no** context, which under
  strict throws at the repository rather than reading. Also correct; `'reject'` moves the failure earlier.

### 8. What REL-2 needs — post-implementation truth

REL-2 (#587) builds include-tree scoping directly on what this PR shipped. This section is the contract, written
after the fact, so REL-2's specifier does not have to re-derive it.

#### 8.1 The primitive, and its exact signature

```ts
export function tenantPredicateFor(
  table: PgTable,
  tenantId: string | null | undefined,
  owner: string,
): SQL | undefined
```

Exported from `runtime/base-classes/base-repository.ts` and re-exported from `runtime/base-classes/index.ts`. It is
a **free function over any `PgTable`**, not a method, precisely so REL-2 can call it for tables that are not the
root repository's. Its three cases are fixed: `undefined` → no predicate; `null` → `IS NULL` (the partition);
a string → `= tenantId`. A table with no `tenant_id` **throws**, naming `owner`.

Unit-pinned in `src/__tests__/runtime/base-classes/base-repository.spec.ts` §"tenantPredicateFor", including the
case that matters to REL-2: the same call against a table the repository does not own.

#### 8.2 Resolve once, pass the value — not the context

`BaseRepository.tenantPredicate()` reads the ALS (via `getTenantId(this.scopeEnforcement, owner)`) and then calls
`tenantPredicateFor`. **REL-2 must not repeat the ALS read per hop.** The root resolves the tenant once per
statement and threads the *value* down the include tree. Two reasons, and the second is the important one:

- an ALS read per hop is wasted work on a deep tree; and
- the hatches (`withTenantScope`, `withAllTenants`) can only be honoured coherently if every hop of one statement
  agrees about the tenant. A per-hop read inside a `withAllTenants` block is fine today but becomes a correctness
  hazard the moment anything can change the context mid-traversal.

The `tenantScope === 'all'` check lives in `tenantPredicate()`, *above* the primitive. REL-2 must make the same
check once, at the root, and skip the whole tree rather than testing it per hop.

#### 8.3 The one thing TEN-1 does NOT build, and cannot

A per-hop answer to **"is the target entity tenant-scoped?"**. Applying the predicate to a table with no
`tenant_id` throws (§M6); skipping it on a table that has one is a leak. Both failure directions are live, so the
question must be answered, not guessed.

It must travel as **generated data**. It must NOT be recovered as `'tenantId' in getColumns(table)`: that is
introspecting generated output to learn what the YAML already says (charter I1), and it would also silently
mis-answer for a host table that happens to carry a `tenant_id` column codegen did not emit.

**Concretely: REL-1's manifest (or a sibling generated per-entity registry) must carry `tenantScoped: boolean` per
entity.** The generator already has the fact in hand — `buildCleanLitePsLocals` computes `tenantScoped` from
`definition.tenant_scoped` and returns it in the locals — so this is a matter of emitting it, not of deriving it.

#### 8.4 What REL-2 inherits for free, and what it does not

**For free.** Every hop that goes through `baseQuery()` / `scopeAnd()` is already scoped: `scopeAnd()` is the single
place a guard is added, and the tenant predicate is now one of them. A traversal that compiles to a root
`baseQuery()` needs no new tenant work at the root.

**Not for free**, and each one is a real edge REL-2 must close:

- **`with:` includes do not route through `scopeAnd()`.** RQBv2 resolves the nested selects itself. Whether the
  spike lands on v2 predefined relation `where` filters or on repository-side include-tree rewriting (charter Q2),
  the predicate has to be *placed* — nothing in TEN-1 places it for a hop.
- **A hop to a non-tenant-scoped entity must be left alone**, per §8.3. "Scope every hop" is wrong; "scope every
  hop whose target is tenant-scoped" is the rule.
- **Junctions are not tenant-scoped at all** (#704). An edge traversed through a junction is scoped by its
  endpoints or not at all — which is a REL-2 decision, and #704 argues it belongs there rather than as a
  `tenant_scoped` flag on the junction YAML.
- **The `MissingTenantIdError` throw is at the root.** A strict traversal fails before any SQL is issued, which is
  the desired behaviour; REL-2 should not catch and degrade it per hop.

#### 8.5 The leak test REL-2 owes

Epic #580's exit criteria call for leak tests at depth ≥ 3. TEN-1's `test/scaffold/tests/tenant-scoping.test.ts` is
the depth-0 version and the shape to copy: seed both tenants, act as A, assert B's rows are invisible *and*
untouchable, and — the part that makes it a proof rather than a restatement — confirm each excluded row is
reachable by *someone*, so a passing test cannot be a row that simply is not there. Its control run is recorded in
§Acceptance.

### 9. Tests

Isolation is a security property (epic #580 exit criteria, charter I3), so the load-bearing proofs are **integration
tests against real Postgres**, not unit tests over fakes.

#### 9.1 Integration — `test/scaffold/tests/tenant-scoping.test.ts` (`just test-integration`)

**As built: three tables, not one.** `test/scaffold/schema.ts` gained `tenantEntities` (the plain case),
`tenantCrmEntities` and `tenantMetadataEntities`. The last two are not decoration — the conflict-target proofs are
proofs *about a constraint*, so the table has to carry the constraint the generator emits:

```ts
unique('uq_tenant_crm_entities_tenant_provider_external_id')
  .on(t.tenantId, t.provider, t.externalId)
  .nullsNotDistinct()
```

Reusing the existing `crmEntities` / `metadataEntities` would have meant adding a tenant column and a constraint to
tables four other suites depend on, and the null-tenant `ON CONFLICT` behaviour (§M5) would have had nothing to
demonstrate against.

The test repositories extend the **real** `BaseRepository`, imported as `@gen/runtime/base-classes/base-repository`
and **not** `@shared/base-classes/base-repository`, which resolves scaffold-first to the hand-written stub (#608,
REL-0 §7). A comment says so, and the file's first assertion pins it by checking that `scopeAnd`, `tenantPredicate`,
`stampTenant` and `baseQuery` are on the prototype — the stub has none of them, and every later assertion would
pass vacuously against it.

Matrix — two tenants A and B, each with rows, all under `withRequester({ …, tenantId })`:

| # | Proof |
|---|---|
| 1 | `findById(bRowId)` as A → `null` (not a 403, not a row — no existence oracle) |
| 2 | `findByIds([aRow, bRow])` as A → only A's |
| 3 | `list()` / `list({ where })` as A → only A's |
| 4 | `count()` as A → A's count only (the M1 regression) |
| 5 | `exists(bRowId)` as A → `false` |
| 6 | `update(bRowId, …)` as A → no row changed; B still reads its original |
| 7 | `delete(bRowId)` as A → no-op; B's row survives (both soft and hard delete) |
| 8 | `create()` as A stamps `tenant_id = A` with no `tenantId` in the input |
| 9 | `create({ tenantId: B })` as A → the explicit value wins (documented behavior) |
| 10 | a declarative finder (`findByName`) as A → only A's — **the M2 regression**, the test that fails today |
| 11 | strict + **no** ambient context → every one of the above throws; nothing returns rows |
| 12 | strict + a context with **no** `tenantId` → `MissingTenantIdError` (read *and* write) |
| 13 | null-tenant partition: `withRequester({ tenantId: null })` sees only `tenant_id IS NULL` rows, and **not** A's or B's |
| 14 | `withAllTenants()` reads across A + B; `create()` inside it throws without an explicit `tenantId` |
| 15 | `withTenantScope(B, …)` nested inside an A context reads B |
| 16 | soft-delete + tenant + `userTracking` all three AND-ed in one statement (no predicate drops another) |

#### 9.2 Integration — the job path

**As built**, in the same file. `bridge-e2e.test.ts` turned out to be no precedent at all — both of its tests are
`test.skip`, pending fixture work that never landed. So the job path is driven directly:

- seed a real `job` row (`job_run.job_type` is a genuine FK to `job.type`) and a real `job_run` with
  `tenant_id = A`, written exactly as the orchestrator would — `root_run_id`, `job_version` and `trigger_source` are
  `NOT NULL` with no default, so the claim query under test is the real one;
- construct a real `JobWorker` against the test database with a `moduleRef` stub returning the handler;
- `await worker.pollAndProcess()`, then settle — it fires the run without awaiting it;
- the handler reads the tenant-scoped repository and records what it saw.

This is the only place the whole chain — persisted `tenant_id` → `withRequester` → `scopeAnd` → SQL → rows — runs
end to end. Three runs (tenant A, tenant B, null) each see exactly their own partition, and the Found #5 guard
asserts a `userTracking` repository read inside a job returns rows rather than the empty list the sentinel user
would have produced under the default `'user'` scope.

#### 9.3 Unit (`just test-unit`) — as built

| File | Covers |
|---|---|
| `src/__tests__/runtime/base-classes/tenant-context.spec.ts` (new) | the three states of `getTenantId` × two enforcement modes; **both** strict throw sites; the two hatches, their nesting, and that they throw SYNCHRONOUSLY when there is no outer context; ALS propagation across an `await`; `SYSTEM_ACTOR_ID` |
| `src/__tests__/runtime/base-classes/base-repository.spec.ts` (extended) | `tenantPredicateFor` for string / null / undefined, its throw on a table with no `tenant_id`, and — the REL-2 contract — the same call against a table the repository does not own; the gating matrix; all four guards in ONE `WHERE`; the null partition; `stampTenant` including the `tenantScope: 'all'` write throw |
| `src/__tests__/runtime/subsystems/job-worker.tenant-als.spec.ts` (new) | `processRun` enters with the run's own tenant, `SYSTEM_ACTOR_ID`, `scope: 'superuser'`; `tenantId: null` is present not absent; the context does not leak past the handler |
| `src/__tests__/clean-lite-ps/tenant-scoping-templates.test.ts` (new) | column (nullable, no `.references()`) + index + `tenantScoped: true` + `scopeEnforcement: 'strict'`; the literal emitted for an otherwise behaviorless entity; the `unique_indexes` prefix with and without an author name; `nullsNotDistinct` on the external-id constraint; the declared `conflictTarget`; no bare single-column unique (§M3); the `eav_value_table` refusal; the junction schema's rejection |
| `src/__tests__/clean-lite-ps/entity-column-features.test.ts` (extended) | #636 — host-owned target emits a plain column and no import, an owned target still gets its FK, `index: true` still applies to the host-owned column |
| `src/__tests__/templates/tenant-scoping-guards.test.ts` (new) | `assertTenantScopingSupported` (permit / refuse / message / non-`true` values); `loadOwnedTableNames` (table vs plural vs pluralized name, nested dirs, malformed YAML, missing dir, and that a `foreign_key` target is not itself owned) |

**The junction assertion is differential on purpose.** A fixture that fails Zod for an unrelated reason would
"pass" a `success === false` check while proving nothing — the first draft of that test did exactly that. It now
parses a real fixture twice: valid without the key, rejected with it, and the issue path names `tenant_scoped`.

`src/__tests__/templates/no-basequery-where.test.ts` needed no change — it already scans `templates/` and
`runtime/`, and SCOPE-0 shipped it.

#### 9.4 Smoke (consumer tsconfig)

`test/smoke/fixtures/tenant_note.yaml` — `tenant_scoped: true` + `timestamps` + `soft_delete` + `user_tracking`, a
composite `unique_indexes:` entry, a `queries:` finder, and a `foreign_key:` to a host-owned table (#636).

No harness change: `run-smoke.ts` **and** `run-smoke-subsystems.ts` both read every `*.yaml` in that directory, so
the fixture joins `just test-smoke` and both legs of `just test-smoke-subsystems` — i.e. it type-checks in **both
runtime modes**, vendored and package, under a consumer's stricter tsconfig. Per charter I9 that is the only gate
that validates a `runtime/base-classes/**` type change at all.

Two honest notes on the fixture:

- The `foreign_key: workspaces.id` field is load-bearing, not filler: if #636's rule regressed, the emitter would
  write `import { workspaces } from '../workspaces/workspace.entity'` and the smoke's `tsc` would fail on the
  unresolved module. It is the gate for that rule.
- It declares `user_tracking`, which proves both axes **compile** on one repository. It does not prove they run:
  clean-lite-ps emits no `user_id` column for that behavior (#617, pre-existing, recorded by SCOPE-0), so executing
  this entity's user axis would throw `table has no column 'userId'`. The smoke is a compile gate and does not
  execute it. The runtime proof of both axes in one statement is §9.1's suite, whose table does carry `user_id`.
  The fixture's own comment says this, so a future reader does not mistake it for a working example.

No baseline movement: `test/fixtures/codegen.config.yaml` is `architecture: clean` and gains no tenant fixture (I11).
One `prompt.js` change was needed to keep the baseline green — see §Acceptance, "What did NOT move".

No baseline movement is expected: `test/fixtures/codegen.config.yaml` is `architecture: clean` (`:54`) and gains no
tenant fixture (I11).

### 10. Documentation (charter §9)

- **`docs/adrs/ADR-042-*.md`** — a dated revision note carrying Found #1–#7: `count()` is not covered; the finders
  discard the guards; §5(c) does not apply to `clean-lite-ps`; §6's `claimed.userId` does not exist and the user axis
  must be `'superuser'`; `getTenantId` must throw on a context without a tenant; the hatches' final names; the §7
  rollout reorder under a strict default. The same edit **scrubs the named consumer** from the ADR (I10) and replaces
  it with "a host application".
- **`docs/specs/TEN-1.md`** — corrected to post-implementation truth in the implementing PR.
- **`PLAN.md` §5A.2 / `PROJECT.md`** — like REL-0 (§Found #6), these are **not** edited on this branch: the
  checkpoint-1 revisions live in unmerged PR #606 and this branch carries the pre-checkpoint copies. The downstream
  facts go in the epic #580 body + log entry; §5A.2 needs one correction once #606 lands (the finder fix and the
  strict default are larger than "exactly the ADR").
- **Issues filed** — #702 (cross-table integration FK resolution is still unscoped), #703 (tenant-scoped upsert on a
  caller-supplied conflict target, incl. the interaction with #687), #704 (junction repositories are not
  tenant-scopable). #636 closes with this PR.

### 11. Explicitly out of scope

- **RLS** (ADR-042 §7 step 4). Optional, consumer-authored, second layer. Codegen emits no policies.
- **Traversal / per-hop application** (REL-2, #587). TEN-1 ships the reusable predicate and states the manifest
  requirement (§8); it applies it at the root only.
- **Junction tables.** Not declarable as `tenant_scoped` (§4.2). Residual: `junctionRepo.findByLeftId(x)` is unscoped —
  bounded, because reaching `x` requires reading a scoped parent, but real. Follow-up issue filed.
- **query-surface / aggregation reads** (ADR-042 §"Insufficient injection points"). They do not go through
  `BaseRepository`; a scope fold in that builder is SEM-track work.
- **Raw `tx.insert(...)` inside a consumer's multi-write transaction.** Irreducible; documented for adopters.
- **The `clean` pipeline** (#602, I11) — not fixed, not filtered, not allowed to emit a tenant-scoped repository.
- **A project-wide `tenancy.default_scoped` config key** (ADR-042 §5 note). Opt-in is the only axis in v1.
- **Deleting `test/scaffold/shared/base-classes/base-repository.ts`** (#608). The new tests route around it (§9.1).

### 12. What downstream must know

- `BehaviorConfig` gains a **required** `tenantScoped: boolean`. Every literal must state it.
- `RequesterContext` gains `tenantId?: string | null` (three states: string / null-partition / absent) and
  `tenantScope?: 'tenant' | 'all'`. `getTenantId(enforcement, owner)`, `MissingTenantIdError`, `withTenantScope`,
  `withAllTenants` and `SYSTEM_ACTOR_ID` are exported from `runtime/base-classes`.
- **`tenantPredicateFor(table, tenantId, owner)`** is the per-hop primitive REL-2 must call. Resolve the tenant once
  per statement; pass the value, not the context.
- **REL-1 must carry `tenantScoped` per entity in the manifest / generated registry.** REL-2 cannot decide per hop
  without it, and deciding by inspecting the table's columns violates I1.
- `this.baseQuery().where(X)` is now **forbidden** (it overwrites the guards — M2) and grep-gated. The form is
  `this.baseQuery(X)`. Any new repository method, generated or hand-written, follows it.
- `count()` now routes through `scopeAnd()`.
- `tenant_scoped: true` implies `scopeEnforcement: 'strict'` for **both** axes on that entity.
- A `tenant_scoped` entity's `tenant_id` is `uuid`; `jobRuns.tenantId` is `text`. Non-UUID tenant identifiers fail
  loudly at Postgres inside a job. Any future change of the entity column's type is a config axis, not a silent widen.
- **A field-level `foreign_key:` to a table no entity YAML generates emits a PLAIN column** — no `.references()`, no
  import (#636). Ownership comes from `loadOwnedTableNames()` in `templates/entity/new/prompt.js`, exposed to the
  clean-lite-ps locals as `ownedTableNames`. If your unit adds a pipeline that emits FK columns, thread it.
- **`MetadataEntityRepository.upsertMany(…, { conflictTarget })` throws on a tenant-scoped repository**, and
  `tenant_scoped: true` + `eav_value_table: true` is a generation-time error (#703).
- **`IntegratedEntityRepository.conflictTarget(declared)`** is the runtime prefix helper. A family base that adds
  its own `ON CONFLICT` path must call it, or state in a comment why its target is already tenant-safe.
- **Cross-table integration FK resolution is still unscoped** (#702). `refTable: 'self'` is scoped; a cross-table
  resolver needs the same per-entity `tenantScoped` fact §8.3 describes.
- `templates/entity/new/prompt.js` exports `assertTenantScopingSupported(definition, architectureTarget)` and
  `loadOwnedTableNames(cwd, entitiesDir?)`. Both are unit-gated in
  `src/__tests__/templates/tenant-scoping-guards.test.ts`.
- The non-clean-lite-ps locals stub in `prompt.js` defines `tenantScoped: false`. EJS walks the CLP template bodies
  under every architecture, so a new CLP-only local must be stubbed there or the baseline gate throws
  `ReferenceError`.

## Acceptance — all met

Output from the run made **after** the last edit (charter I9). Every gate ran with a private `TMPDIR` (#691 — the
shared `bunx` hygen cache races between concurrent worktrees).

| Gate | Result |
|---|---|
| `bun run typecheck` | **exit 0** |
| `just test-all` | **exit 0** — typecheck · unit **3303/3303, 0 skipped** (was 3195; +108). The 3 tests SCOPE-0 recorded as skipped are `dist-singleton-dedup.spec.ts`, which runs only when `dist/` exists — `just test-post-publish` had built it before this run, so they executed here. Nothing was un-skipped by this PR. · baseline · smoke · smoke-subsystems (vendored + package) · smoke-relationship · smoke-junction · smoke-junction-cross-domain · junction snapshots 10/10 · integration-emit 56/56 · smoke-integration |
| `just test-integration` | **exit 0** — **117 pass · 2 skip · 0 fail** (was 80 pass; +37 the new suite) |
| `just test-smoke` | **exit 0** — run inside `test-all`; mandatory because `runtime/base-classes/**` changed and `bun run typecheck` does not compile that tree under a consumer tsconfig |
| `just test-post-publish` | **exit 0** — tarball smoke, because `runtime/` ships |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, still exactly **118**; not repaired, not filtered |

**The control run.** 117/117 passing proves nothing on its own — a tenant test that never had a tenant to exclude
would pass too. So the tenant predicate and the create stamp were neutered (`tenantPredicate()` → `undefined`,
`stampTenant()` → identity) and the suite re-run against real Postgres: **90 pass · 27 fail**. Twenty-seven of the
new assertions detect the absence of the fix. The isolation claims are measurements, not restatements.

No filtered error classes, no scope carve-outs. No new `any` or `as unknown as` in `runtime/**`.

### Snapshot churn — one class, explained

`test/junction/__snapshots__/*.snap` gained three lines each: the junction repository's `behaviors` literal now
states `tenantScoped: false` with the comment saying why junctions cannot opt in. That is the whole diff. It
follows from `BehaviorConfig.tenantScoped` being **required** rather than optional-with-a-default (§2, charter I7):
every literal in the tree is forced to state its posture, including the ones whose answer is "no".

### What did NOT move

- `test/baseline/` — unchanged. `test/fixtures/codegen.config.yaml` is `architecture: clean` and gained no tenant
  fixture (I11). One `prompt.js` change was needed for it to keep passing: the non-CLP locals stub must define
  `tenantScoped: false`, because EJS walks the clean-lite-ps template bodies under every architecture.
- `just test-smoke-junction-clean` — still 118, the same 118.

## Risks — outcome

| Risk | Outcome |
|---|---|
| The M2 finder fix changes behavior for existing **non**-tenant entities | **Moot** — shipped ahead of this PR as SCOPE-0 (#616), which absorbed the one test that had encoded the leaky result. |
| Strict-by-default breaks a call path with no boundary | **Did not happen.** No harness reached a tenant-scoped repository without a boundary, because no existing fixture is tenant-scoped — the flag is opt-in and the only entity that carries it is the new smoke fixture, which is compiled and not executed. No lenient opt-down was added. |
| The nullable tenant column + `ON CONFLICT` inference (M5) behaves differently than measured | **Did not happen**, and it is now measured rather than inferred: the scaffold table carries the real `unique(...).nullsNotDistinct()` constraint, and an integration test upserts twice in the null partition and asserts one row. |
| `col('tenantId')` throws on a path that previously limped along | **Did not happen.** The throw is unit-pinned as the intended backstop (a `tenantScoped: true` repository over a table with no `tenant_id` fails at the first statement) rather than encountered by accident. |
| §5 expands the PR past a reviewable size | The gate ruled §5 **in** before implementation, so the split was never exercised. Two paths inside it still fail closed (#703). |
| rc.4 → GA moves `unique().nullsNotDistinct()` or the `.where()` overwrite semantics | **Live.** Both are now load-bearing in shipped code. Carry M5 and the `.where()` overwrite into DRZ-2's A-checklist as A15/A16. |
| The baseline gate breaks on a CLP-only local | **Happened.** EJS walks the clean-lite-ps template bodies under `architecture: clean` too, so `tenantScoped` had to be stubbed `false` in `prompt.js`'s non-CLP locals. Recorded in §12 so the next CLP-only local does not rediscover it. |

| Live risk | Signal | Response |
|---|---|---|
| A new family base adds an `ON CONFLICT` path without a tenant-safe target | a cross-tenant `UPDATE` with a green build | `conflictTarget()` exists to be called; `scopeAnd()` cannot reach an upsert's target, and no test will catch it unless the family gets one |
| REL-2 applies the predicate per hop without the per-entity `tenantScoped` fact | a throw on a non-tenant table, or a silently unscoped hop | §8.3 — it must come from generated data. Do not reach for `getColumns(table)` |
| A host's tenant identifier is not a UUID | a Postgres invalid-input error inside a job | fail-loud, not a leak (§M4). The entity column's type is a config axis if it ever needs to change, not a silent widen |

## Decisions — settled at the gate, recorded here

All four were decided before implementation and all four are now built. Nothing in this section is open.

**1. §5 (the conflict-target write paths) is IN, not deferred to TEN-2.** Both paths shipped:

- **Integrated upserts** — `integrationUpsertOne` stamps through `stampTenant()` and resolves its `ON CONFLICT`
  target through a new `conflictTarget()` helper that prefixes `tenantId` when the repository is tenant-scoped. The
  generated `integrationConfig.conflictTarget` already carries it (charter I1); the helper is the runtime backstop
  that makes a hand-written config safe too, and it never double-prefixes. `findByExternalIdProjected`,
  `softDeleteByExternalId` and `integrationUpsert`'s re-read all route through `scopeAnd()`.
- **`MetadataEntityRepository.upsertMany`** — with a caller-supplied `conflictTarget` on a tenant-scoped
  repository, it **throws**, naming **#703**. The target is a single author-declared column: prefixing `tenant_id`
  breaks `ON CONFLICT` inference against the author's index, and not prefixing it means one tenant's batch updates
  another tenant's rows. Failing closed is the only honest third option. The `conflictTarget`-less path delegates
  to `create()` and is covered. `tenant_scoped: true` + `eav_value_table: true` is a generation-time error for the
  same reason.

**#687 is NOT fixed here, deliberately.** That defect — `upsertMany` overwriting every conflicting row with the
first input's values — lives in the branch a tenant-scoped repository now throws before reaching. It is orthogonal
to tenancy, and folding it into this PR would mix an isolation change with a batch-semantics change in one diff.
It stayed out of the way, so it stayed out. Recorded on #703 so whichever lands first does not paper over the other.

**2. `scopeEnforcement: 'strict'` is the default for `tenant_scoped: true`, with NO opt-down.** The template emits
`protected override readonly scopeEnforcement = 'strict' as const;`. A missing tenant is always an error. ADR-042
§7's rollout reverses — boundary first, flag second — and that reversal is recorded as a dated revision note on the
ADR (§10). The same knob governs the user axis; §3.4 states the consequence.

**3. The hatches are `withTenantScope(tenantId, fn)` and `withAllTenants(fn)`**, matching the existing
`withUserScope` / `withOrgScope` / `withSuperuserScope` family. The repository's stamp helper is `stampTenant`, so
no name collides.

**4. #636 — a field-level `foreign_key:` to a host-owned table is ALLOWED, explicitly.**

The rule, now implemented: **codegen emits a DB-level FK only for a table it generates.** A `foreign_key:
<table>.<column>` naming a table no entity YAML declares belongs to the host application — a tenants table, a users
table from an auth provider. That is a legitimate declaration, and the reference is real; it simply is not
codegen's to enforce. The column is emitted **plain**: no `.references()`, no import. Referential integrity for a
host-owned table is the host's, in its own migration.

This is #636's option 2, made explicit rather than arrived at by accident. The alternatives both fail: emitting the
import produces `import { tenants } from '../tenants/tenant.entity'`, a module codegen never writes (the behaviour
this branch had); and erroring forbids a declaration that is correct.

Ownership is decided by `loadOwnedTableNames()` (`templates/entity/new/prompt.js`), which reads `entity.table` —
falling back to `entity.plural`, then the pluralized name — from every YAML under the entities directory. It reads
the **YAML**, never emitted files, so a two-pass generation gives the same answer on both passes (charter I1). A
project whose locals are built without `prompt.js` passes no list, and every target is then treated as owned.

The `tenant_id` column TEN-1 emits is exactly this shape — a bare `uuid` pointing at a table codegen does not own —
so the rule and the feature agree rather than needing an exception for one of them. #636 closes with this PR.

**Interaction with NAME-0 (#630), which is NOT on this branch.** #630 turned the same case into a generation error
naming the table; that work lives on `dugshub/630-target-naming` and is not an ancestor here. When the two stacks
meet, NAME-0's error must be replaced by this rule, not layered over it: the two disagree, and this one is the
decision. NAME-0's *other* contribution — resolving an owned target's names from the target's own YAML rather than
re-pluralizing — is orthogonal and unaffected.
