# ADR-042 — Automatic Repository-Level Tenant Scoping (ALS-fed, opt-in, a mirror of `userTracking`)

**Status:** Proposed
**Date:** 2026-06-21
**Owner:** Doug
**Related:** ADR-001 (DDD + hexagonal — the repository/service/use-case layering this decision exploits), ADR-005 (entity-family base classes — `BaseRepository` is the choke point), ADR-022 (job orchestration domain — the `MissingTenantIdError` + per-run `tenantId` precedent this extends to entity repos), ADR-037 (runtime mode — package-mode emission constraints), swe-brain `ADR-0031` (tenant registration under single-trusted-tenancy — the driving consumer whose deferred "hardened multi-tenant flip" this ADR mechanizes)

> **Sequencing note.** This ADR settles the *mechanism* for automatic data isolation. It is opt-in and additive: nothing changes for an entity until it carries `tenant_scoped: true`, and the new ALS field is ignored by every existing `userTracking`-only repo. The driving consumer (swe-brain) shipped tenant registration trusting a single tenant (its ADR-0031) and pre-loaded a `tenantId` claim into its access JWT *in anticipation of this seam* — so adoption is a config change plus a boundary interceptor, not a hand-port across N repositories.

## Context

Codegen has had **two unrelated meanings** for "multi-tenant" that have never met:

1. **Subsystem tenant *presence* enforcement.** Each of the four stateful subsystems (events, jobs, bridge, integration) accepts `multi_tenant: true` in `codegen.config.yaml`. The barrel generator threads it as `multiTenant = Boolean(cfg?.multi_tenant)` into every `forRoot(...)` call (`src/cli/shared/subsystem-barrel-generator.ts:259` events, `:326` jobs, `:383` bridge, `:412` integration). At runtime the jobs domain throws `MissingTenantIdError` when a tenant-scoped call omits `tenantId` (`runtime/subsystems/jobs/jobs-errors.ts:93-103`). This is **fail-loud-on-missing-tenant** — it guarantees a `tenant_id` is *written*, and that background work can't silently default to "the last tenant seen."

2. **Entity-repository query *isolation*.** This **does not exist.** Generated entity repositories emit zero tenant filtering. The one ambient scope they understand is `userTracking` (`runtime/base-classes/base-repository.ts:273-292`, `scopePredicate()`), which filters by `user_id` — a *per-user* axis, not a *per-tenant* one.

The gap is the dangerous part. A consumer who flips `multi_tenant: true` on the subsystems gets presence-enforcement and reasonably assumes isolation came with it. It did not. Every generated `findById` / `list` / `count` still reads across tenants, because `BaseRepository.scopeAnd()` (`base-repository.ts:300-312`) only AND-s in the `userTracking` predicate and the soft-delete guard. There is no `WHERE tenant_id = ?` anywhere in the generated tree.

Closing that gap by hand is exactly the mechanical, every-entity, easy-to-forget work codegen exists to own. And the floor for doing it *well* is already in place:

- **A single repository choke point.** Every read flows through `baseQuery(extra)` → `scopeAnd(extra, { softDelete })` (`base-repository.ts:254-258`); every by-id write (`update`, `delete`) flows through `scopeAnd(eq(table.id, id))` (`:206`, `:222`, `:226`); `create()` is the single insert path (`:188-195`). One class, a handful of methods.
- **A proven ambient-context mechanism.** `RequesterContext` + `withRequester(ctx, fn)` + `requireRequester()` / `tryGetRequester()` (`runtime/base-classes/tenant-context.ts:64-127`) already carry `userId` / `organizationId` / `scope` through every `await` without signature pollution. The `userTracking` scope rides it today. **Tenant scope is the same shape, one field wider.**
- **A `scopeEnforcement: 'lenient' | 'strict'` knob** (`base-repository.ts:80`) that already governs "what happens when no context is active." We reuse it verbatim.
- **A per-run `tenantId` already persisted on jobs.** `jobRuns.tenantId` exists (`runtime/subsystems/jobs/job-orchestration.schema.ts:137`) and is already threaded into orchestrator calls from a run's own tenant (`job-worker.ts:749`, the parent-close cascade). The piece missing for jobs is entering the *repository* ALS scope from that value.

This ADR makes meaning #2 real, as a near-mechanical mirror of meaning the repo already implements for `userTracking`.

## Decision

Adopt **repository-level, ALS-fed, opt-in tenant scoping**, structurally identical to the existing `userTracking` scope. The unit of opt-in is the entity (`tenant_scoped: true`); the enforcement point is `BaseRepository`; the context source is the existing `RequesterContext` ALS.

### 1. Level = repository (not service, not DB-only)

The choke point is `BaseRepository`. Reads go through `scopeAnd()`; writes-by-id inherit it; `create()` stamps the column. Nothing below the repository can read or write a row without passing the same gate.

**Why not the service layer.** Under ADR-001 services are thin pass-throughs over the repository, and — load-bearing — **consumers hand-author services** (ADR-001 "Hand-written use case inventory must be maintained"; the generated clean-lite-ps service is mostly inherited base methods + `queries:` pass-throughs, `templates/entity/new/clean-lite-ps/service.ejs.t:94-99`). A service-layer filter is one a consumer can forget to add or accidentally route around by calling the repo directly. The repository is the one layer codegen *fully* owns and every path *must* traverse.

**Why not DB row-level security as the primary.** RLS is excellent defense-in-depth, but it cannot be the primary mechanism here:

- It needs a per-table `CREATE POLICY` plus `ENABLE ROW LEVEL SECURITY`, emitted per entity — strictly more migration surface than a single base-class change.
- It reads the tenant from a session GUC (`current_setting('app.tenant_id')`), which means a `SET LOCAL app.tenant_id = ...` on **every transaction** — a connection-pool-and-transaction discipline the generated runtime does not impose today.
- It is invisible to application-level reasoning and to the query-surface read path.

So RLS is proposed as an **optional second layer** (§7), authored after the application-level scope is in place, for belt-and-suspenders consumers — never as the primary.

### 2. Reuse the existing ALS — one field wider

Extend `RequesterContext` with an optional tenant id:

```diff
 export interface RequesterContext {
   readonly userId: string;
   readonly organizationId: string | null;
   readonly scope?: RequesterScope;
   readonly orgUserIds?: readonly string[];
+  /**
+   * The tenant the request acts within. Seeded at the SAME boundary that
+   * seeds userId (see tenant-context.ts "Where to set it"). Read by
+   * BaseRepository.scopePredicate() when behaviors.tenantScoped === true.
+   *   - string  → scope every read/write to this tenant.
+   *   - null    → the "null-tenant" partition (system/cross-tenant rows);
+   *               filters with IS NULL, stamps NULL on create.
+   *   - absent  → no tenant established; lenient = unscoped, strict = throw.
+   */
+  readonly tenantId?: string | null;
 }
```

The same `withRequester({ userId, organizationId, tenantId }, fn)` call site that already exists at each boundary (`tenant-context.ts:8-17`) now carries the tenant too. No new ALS, no new propagation path, no new injection plumbing.

Add a `getTenantId()` helper next to the existing scope helpers (`tenant-context.ts:132-175`):

```ts
/** Read the ambient tenantId. Mode-aware: strict throws on absence. */
export function getTenantId(enforcement: 'lenient' | 'strict'): string | null | undefined {
  const ctx = enforcement === 'strict' ? requireRequester() : tryGetRequester();
  return ctx ? ctx.tenantId : undefined;     // `undefined` = no context (lenient)
}
```

Add `tenantScoped` to the repository's `BehaviorConfig` (`base-repository.ts:30-34`):

```diff
 export interface BehaviorConfig {
   timestamps: boolean;
   softDelete: boolean;
   userTracking: boolean;
+  tenantScoped: boolean;
 }
```

### 3. The scope predicate + the create stamp (the diff that does the work)

A new `tenantPredicate()` mirrors `scopePredicate()` (`base-repository.ts:273-292`) line-for-line, and `scopeAnd()` (`:300-312`) AND-s it in alongside the user scope and soft-delete guard. Because `scopeAnd()` is what `baseQuery()`, `update()` and `delete()` all call, **every read and every by-id write is covered by this single addition**:

```diff
 protected scopeAnd(extra?: SQL, opts?: { softDelete?: boolean }): SQL | undefined {
   const conditions: SQL[] = [];
   if (opts?.softDelete) conditions.push(isNull(this.table['deletedAt']));
   const scope = this.scopePredicate();
   if (scope) conditions.push(scope);
+  const tenant = this.tenantPredicate();
+  if (tenant) conditions.push(tenant);
   if (extra) conditions.push(extra);
   if (conditions.length === 0) return undefined;
   if (conditions.length === 1) return conditions[0];
   return and(...conditions);
 }

+protected tenantPredicate(): SQL | undefined {
+  if (!this.behaviors.tenantScoped) return undefined;
+  const tenantId = getTenantId(this.scopeEnforcement);
+  if (tenantId === undefined) return undefined;          // lenient, no context → unscoped (see §4)
+  return tenantId === null
+    ? isNull(this.table['tenantId'])
+    : eq(this.table['tenantId'], tenantId);
+}
```

`create()` (`base-repository.ts:188-195`) stamps `tenant_id` from the ambient context, exactly as `withTimestamps()` stamps `createdAt`:

```diff
 async create(input: Partial<TEntity>, tx?: DrizzleTx): Promise<TEntity> {
-  const data = this.withTimestamps(input as Record<string, unknown>, 'create');
+  const data = this.withTenant(
+    this.withTimestamps(input as Record<string, unknown>, 'create'),
+  );
   const rows = await this.runner(tx).insert(this.table).values(data as any).returning();
   return rows[0] as TEntity;
 }

+protected withTenant(input: Record<string, unknown>): Record<string, unknown> {
+  if (!this.behaviors.tenantScoped) return input;
+  // An explicitly-supplied tenant_id wins (cross-tenant tooling under
+  // runUnscoped may set it deliberately); otherwise stamp from the ALS.
+  if (input['tenantId'] !== undefined) return input;
+  const tenantId = getTenantId(this.scopeEnforcement);   // throws in strict if absent (§4)
+  return { ...input, tenantId: tenantId ?? null };
+}
```

`update()` and `delete()` need **no change**: they already route through `scopeAnd(eq(table.id, id))`, so a cross-tenant write matches zero rows and is a no-op (the same "returns null/[] — identical to truly doesn't exist" not-found semantics the ALS doc already documents, `tenant-context.ts:33-37`). No existence oracle leaks across tenants.

### 4. Fail-closed, governed by `scopeEnforcement`

A `tenant_scoped` entity with **no ambient tenant and not inside an explicit unscoped block** is the dangerous case — it is the difference between "isolate" and "leak the union of all tenants." Behavior is governed by the existing `scopeEnforcement` knob (`base-repository.ts:80`), reusing its semantics verbatim:

- **`'strict'` (recommended for tenant-scoped consumers):** `getTenantId('strict')` calls `requireRequester()`, which throws when no context is active (`tenant-context.ts:109-118`). A missing boundary is a loud failure, not a silent cross-tenant read. On the **write** path, codegen additionally throws a repository-level `MissingTenantIdError` — a direct mirror of the jobs one (`jobs-errors.ts:93-103`) — so a tenant-scoped `create()` with no resolvable tenant fails at the call site rather than persisting an orphaned-or-leaked row.
- **`'lenient'` (default, for additive adoption):** no context → `tenantPredicate()` returns `undefined` → unscoped, preserving pre-scoping behavior so flipping `tenant_scoped: true` is non-breaking until a boundary installs `withRequester(...)` (the identical additive-adoption story the `scopeEnforcement` docblock already states for `userTracking`, `base-repository.ts:71-79`).

The new repository `MissingTenantIdError` follows the jobs error's three-state contract (`jobs-errors.ts:88-102`): a resolvable tenant string passes; an **explicit** `null` tenant passes and writes the null-tenant partition (cross-tenant background work); an **absent** tenant under strict throws.

### 5. Per-entity opt-in: `tenant_scoped: true`

A single entity-YAML flag drives three emission changes. Add it to `EntityDefinitionSchema` (`src/schema/entity-definition.schema.ts:830-952`, alongside the existing top-level `eav` / `unique_indexes` flags):

```ts
// Repository-level tenant isolation (ADR-042). When true, codegen:
//   (a) emits a nullable `tenant_id` column on this entity's table,
//   (b) sets `tenantScoped: true` in the generated BehaviorConfig,
//   (c) makes `queries: { by:[x], unique:true }` emit a COMPOSITE
//       (tenant_id, x) unique index + a tenant-scoped finder.
// Defaults to false. There is NO per-entity OVERRIDE today (see §note).
tenant_scoped: z.boolean().optional().default(false),
```

The three emission sites, with line-accurate anchors:

**(a) The `tenant_id` column.** The clean-lite-ps schema is emitted by `templates/entity/new/clean-lite-ps/entity.ejs.t`. Add a `tenant_id` column in the behavior-fields region (next to the `hasTimestamps` / `hasSoftDelete` blocks at `entity.ejs.t:64-70`), nullable by default per §7:

```ejs
<%_ if (tenantScoped) { _%>
    tenantId: uuid('tenant_id'),
<%_ } _%>
```

**(b) The `BehaviorConfig` flag.** The generated repository's behavior literal is at `templates/entity/new/clean-lite-ps/repository.ejs.t:104-108`. Add one line, exactly mirroring `userTracking`:

```diff
   protected override readonly behaviors: BehaviorConfig = {
     timestamps: <%= !!hasTimestamps %>,
     softDelete: <%= !!hasSoftDelete %>,
     userTracking: <%= !!hasUserTracking %>,
+    tenantScoped: <%= !!tenantScoped %>,
   };
```

(The guard at `repository.ejs.t:101` must also fire when `tenantScoped` is set, so the literal is emitted for a tenant-scoped-but-otherwise-behaviorless entity.)

**(c) Composite unique → `(tenant_id, x)`.** This is the subtle, must-get-right part. A `tenant_scoped` entity may legitimately have two rows with the same `email` (tenant A's user and tenant B's user). A single-column `unique: true` would forbid that. So when `tenant_scoped`, every declared single-column uniqueness (`queries: { by: [x], unique: true }` per `QueryDeclarationSchema`, `entity-definition.schema.ts:571-578`; and field-level `unique: true`, `BaseFieldSchema:199`) must be rewritten as a **composite `(tenant_id, x)`** unique index, and the generated `findByX` finder gains the ambient tenant filter for free via `baseQuery()` (the finder already calls `baseQuery()` at `repository.ejs.t:115`, so once `tenantScoped` is in `BehaviorConfig` the tenant predicate is AND-ed in with no template change to the finder body).

The composite-index machinery **already exists** — it is `processUniqueIndexes()` in `templates/entity/new/clean-lite-ps/prompt-extension.js:601-609`, which emits `uniqueIndex('<name>').on(<cols>)` into the pgTable extra-config callback consumed at `entity.ejs.t:73-81` (`clpTableConstraints`). The `external_id_tracking` behavior is the existing precedent for *machine-synthesized* composite uniqueness: it injects a `uniqueIndex` over `(provider, external_id)` (`prompt-extension.js:642-646`, `:1308`). Tenant scoping reuses that path: when `tenant_scoped`, prepend `tenant_id` to each single-column unique's column list before it reaches `processUniqueIndexes()`, and suppress the bare per-field `.unique()` in favor of the composite. This is additive code in `prompt-extension.js`, not a new emission paradigm.

> **Note — no per-entity *override* today.** `tenant_scoped` is an opt-*in*; there is no inverse "this one entity escapes a project-wide tenant default," because there is no project-wide default. If a future `codegen.config.yaml` `tenancy.default_scoped: true` lands, the per-entity flag becomes the override; until then opt-in is the only axis.

### 6. Jobs / background context — enter the ALS from the run's `tenantId`

HTTP/tRPC requests seed the ALS at their boundary from the validated principal — the consumer wires *where the tenant comes from* (e.g. a JWT `tenantId` claim), exactly as they wire the `userId` source today (`tenant-context.ts:8-17`). Codegen does not invent the source; it consumes whatever the boundary installs.

**Jobs have no request**, so the worker must establish the scope itself. The job worker run loop is `runtime/subsystems/jobs/job-worker.ts`; the handler executes inside `processRun()` at `job-worker.ts:684` (`await handler.run(ctx)`). The claimed row already carries its tenant (`claimed.tenantId`, the same field threaded into the cascade-cancel at `job-worker.ts:749`). Wrap the handler body in `withRequester` from the run's persisted tenant:

```diff
-      const output = (await handler.run(ctx)) as Record<string, unknown> | undefined;
+      const output = (await withRequester(
+        { userId: claimed.userId ?? SYSTEM_USER, tenantId: claimed.tenantId },
+        () => handler.run(ctx) as Promise<Record<string, unknown> | undefined>,
+      ));
```

This makes every entity-repository read/write performed *inside* a job handler automatically tenant-scoped to the job's own tenant — the background-work counterpart of the HTTP boundary, and the natural completion of JOB-8's existing per-run tenancy. (The `userId` source for the audit-trail field is a consumer concern; jobs that act on behalf of a user persist it, system jobs use a sentinel.)

### 7. Rollout / migration: nullable → backfill → NOT NULL → (optional) RLS

Codegen emits schema and code; it **cannot backfill a consumer's existing rows**. So the column ships nullable and the consumer tightens it in their own migration sequence:

1. **Emit `tenant_id` NULLABLE.** Flipping `tenant_scoped: true` + regen + `db-diff` produces an additive, non-destructive `ADD COLUMN tenant_id uuid` (every existing row gets `NULL`). Under `scopeEnforcement: 'lenient'` nothing breaks yet.
2. **Backfill.** The consumer writes a one-time migration/script setting `tenant_id` to the correct tenant for existing rows (for swe-brain: the single seed tenant — see below).
3. **Flip NOT NULL.** Once backfilled, the consumer adds `ALTER COLUMN tenant_id SET NOT NULL` and flips the repo to `scopeEnforcement: 'strict'`. From here, a missing-tenant boundary fails loud.
4. **(Optional) Add RLS.** For defense-in-depth, the consumer authors `ENABLE ROW LEVEL SECURITY` + a `CREATE POLICY USING (tenant_id = current_setting('app.tenant_id')::uuid)` per tenant-scoped table, and a boundary that issues `SET LOCAL app.tenant_id` per transaction. This is the §1 "optional second layer" and is purely consumer-authored migration SQL; codegen does not emit it in v1.

Each step is independently shippable, and steps 1-2 are non-breaking, which is what lets a live consumer adopt incrementally.

### Insufficient injection points (the discipline this does NOT cover)

The repository choke point covers `findById` / `findByIds` / `list` / `count` / `exists` (all via `baseQuery`), `create`, `update`, `delete`, and the declarative `findByX` finders — because every one routes through `baseQuery()`/`scopeAnd()`/`create()`. It does **not** cover, and these each need manual `scopeAnd()` / `getTenantId()` discipline, documented loudly for adopters:

- **Raw `this.db.select()` outside `baseQuery()`.** Any hand-authored repository method that builds its own select bypasses the guard. The base already warns about this for the soft-delete/scope case (`base-repository.ts:243-253` — "Pass the leaf predicate as `extra` rather than chaining a second `.where(...)`"); the same rule now also protects tenant isolation. Hand-rolled selects MUST pass through `baseQuery(extra)` or AND in `this.tenantPredicate()` themselves.
- **`upsertMany()` overrides with raw `.onConflict()`.** The base `upsertMany` delegates to `create()` (`base-repository.ts:235-237`) and is therefore covered — but family bases override it with a real conflict-target upsert (the docblock at `:230-234` calls this out; the integration sink's `integrationUpsert` and EAV's `upsertCurrentValues` are live overrides). Those overrides build their own `INSERT ... ON CONFLICT` and must stamp + filter `tenant_id` by hand.
- **Future query-surface / aggregation read paths.** swe-brain's `@pattern-stack/query-surface` reads do not go through `BaseRepository` at all. Tenant scoping there is a separate seam (a scope fold in the query builder) and is explicitly out of scope for this ADR — flagged so no one assumes the repo fix covers analytics.
- **Multi-write transactions.** Inside a `db.transaction(...)`, only writes that go through the repository's `create()`/`scopeAnd()` honor the tenant; a raw `tx.insert(...)`/`tx.update(...)` in the same transaction does not. Compound writes must route every statement through the repo or stamp/filter by hand.

These are the irreducible remainder. The ADR's claim is "isolation-by-default for the generated path," not "isolation no hand-authored code can defeat."

## Consequences

**Positive.**

- **Isolation-by-default once opted in.** A `tenant_scoped: true` entity reads and writes its own tenant with zero hand-authored filtering on the generated path — the gap between "presence-enforced" and "isolated" closes.
- **One mechanism, one choke point.** Reads, by-id writes, and creates are all covered by a single `tenantPredicate()` + `withTenant()` addition to `BaseRepository`, because every path already funnels through `scopeAnd()`/`create()`.
- **It is a mirror, not an invention.** `tenantScoped` is structurally `userTracking` with `tenant_id` instead of `user_id`; it reuses the ALS, the `scopeEnforcement` knob, the not-found semantics, the additive-adoption story, the jobs `MissingTenantIdError` shape, and the existing composite-index emitter. Minimal new surface, maximal reuse of proven code.
- **Mechanizes a deferred consumer decision.** swe-brain's "hardened multi-tenant flip" becomes a config + boundary-interceptor change rather than an N-repository hand-port.

**Cost / negative.**

- **Escape-hatch discipline.** Cross-tenant code paths (registration's tenant-by-domain lookup, super-admin tooling, the tenant table itself) MUST use the mandatory escape hatches — `withTenant(tenantId, fn)` to override and `runUnscoped(fn)` to drop the filter entirely (thin wrappers over `withRequester`; without them you cannot even *resolve* a tenant at signup, since the tenant lookup itself can't be tenant-scoped). Forgetting `runUnscoped` in tooling yields confusing empty results; this is the cost of fail-closed.
- **Raw-query gaps** (the "insufficient injection points" list) remain a manual responsibility and need consumer documentation.
- **Composite-unique migration is a real schema change.** Flipping `tenant_scoped` on an entity with existing single-column uniques rewrites those constraints to `(tenant_id, x)`; the consumer must drop the old unique and add the composite in their migration. Atlas surfaces this as a diff to review, not a silent change.
- **Strict mode is unforgiving by design.** Once on strict + NOT NULL, any code path that reaches a tenant-scoped repo without a boundary throws. That is the point, but it raises the bar on test setup (tests must `withRequester(...)` or `runUnscoped(...)`, the same rule the ALS doc already states for `userTracking` tests, `tenant-context.ts:39-43`).

**Neutral.**

- The `tenant_id` column is `uuid` to match the consumer's tenant PK convention (and `defaultRandom()` id shape); a consumer with a non-uuid tenant key adjusts the emitted type the same way they would any FK.
- RLS remains entirely optional and consumer-authored — codegen's posture is unchanged unless a future ADR opts to emit policies.
- The `null` tenant partition (system/cross-tenant rows) is a first-class value, mirroring the jobs `tenant_id = NULL` cross-tenant-work semantics (`jobs-errors.ts:96-102`), not a second-class hack.

## Alternatives considered

- **Service-layer scoping.** Filter in the generated service instead of the repository. **Rejected:** services are hand-authored under ADR-001 and routinely bypassed by direct repo reads (ADR-001 rule 2, "reads may shortcut"); a filter there is missable and route-around-able. The repository is the only fully-codegen-owned layer every path must traverse.
- **DB RLS as the primary.** **Rejected as primary, adopted as optional §7 layer:** RLS needs per-table policies, `ENABLE ROW LEVEL SECURITY` per entity, and a `SET LOCAL` per transaction (a pool/transaction discipline the runtime doesn't impose), and it is invisible to the application + query-surface read paths. Excellent second line of defense, wrong first line.
- **A query-builder wrapper.** Wrap Drizzle's `select`/`insert` in a tenant-aware shim. **Rejected:** it duplicates the `scopeAnd()`/`baseQuery()` choke point that already exists, would need every repo to adopt the wrapper, and fights Drizzle's `.where()`-overrides-not-ANDs footgun the base already solved (`base-repository.ts:248-252`).
- **Per-entity hand-authored filters.** The status quo — every consumer writes `WHERE tenant_id = ?` per repo. **Rejected:** this is precisely the mechanical, per-entity, easy-to-forget work codegen exists to eliminate (ADR-001 "manual consistency across N modules is a losing battle"). It is also exactly what one forgotten line turns into a cross-tenant leak.

**Why repository-level + ALS wins:** it is a single choke point (already the case for `userTracking`), codegen-owned end to end, and a structural mirror of a mechanism already shipped, tested, and trusted in this exact pipeline — the lowest-risk way to make isolation the default.

## Open follow-ups (implementation-time; not blocking this decision)

1. Name and ship the two escape hatches — `withTenant(tenantId, fn)` and `runUnscoped(fn)` — as thin `withRequester` wrappers in `tenant-context.ts`, next to `withUserScope` / `withSuperuserScope` (`:147-175`).
2. Decide the `userId` source for tenant-scoped *system* jobs (sentinel vs. nullable) when wrapping `processRun`'s handler call (`job-worker.ts:684`) — the run's `userId` may be absent for purely system-triggered runs.
3. Confirm the composite-unique rewrite in `processUniqueIndexes` (`prompt-extension.js:601-609`) correctly suppresses the per-field `.unique()` when `tenant_scoped`, so an entity doesn't emit both a bare and a composite unique on the same column.
4. A tenant-isolation smoke fixture: two tenants, one entity, assert tenant A's `findById` returns `null` for tenant B's row under strict mode (the regression guard that this didn't silently regress to cross-tenant reads).
5. Worked adoption checklist for swe-brain (the driving consumer): flip `tenant_scoped: true` per entity → add an HTTP interceptor that seeds `withRequester({ userId, tenantId })` from the existing access-JWT `tenantId` claim → backfill existing rows to the seed tenant → flip NOT NULL + `scopeEnforcement: 'strict'`. This sequence turns ADR-0031's deferred hardened-tenancy into a config change, validating the mechanism against a real consumer.
