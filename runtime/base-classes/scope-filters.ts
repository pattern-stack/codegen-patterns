/**
 * The scope predicate, for ONE table — REL-2 (#587) §3.
 *
 * A nested read that filters the root by tenant and then joins a child table
 * unfiltered is a cross-tenant read path wearing a type signature. The rule this
 * file exists to make structural is charter I3: *the root and every hop of an
 * include tree carry the same guards, built by the same function.*
 *
 * Three call sites, one implementation:
 *
 *  1. `BaseRepository.scopePredicate()` — the root of the core
 *     `select().from()` builder, folded into the single `WHERE` by `scopeAnd()`.
 *  2. The generated repository's RQBv2 root filter — `{ RAW: (t) => … }` on
 *     `db.query.<table>.findFirst/findMany`, which is the path a `with` include
 *     takes (`baseQuery()` cannot carry a `with`). Note the `t`: the relational
 *     query builder ALIASES the root, so the predicate must render against the
 *     handle it passes the callback, never against the repository's own.
 *  3. The emitted relations manifest — `where: { RAW: (t) => hopScope(t, …) }`
 *     on every relation whose target declares a scope, so the predicate travels
 *     with the RELATION rather than with the call site.
 *
 * (3) is the whole reason this is a free function over an arbitrary `PgTable`
 * rather than a method. REL-2 §1.4 measured the alternative — a repository that
 * rewrites the caller's include tree — and found a reachable unscoped hop:
 * RQBv2 traverses a relation in two places, the `with:` lateral AND the
 * `where: { <relation>: … }` EXISTS subquery, and a rewriter only ever sees the
 * first. With the predicate on the relation, both are scoped, and so is a
 * hand-written `db.query.*` that never goes through a repository at all.
 *
 * The ALS is read HERE, at query-build time, once per traversed relation —
 * measured in REL-2 §1.2, and the reason a module-level manifest can carry a
 * per-request predicate at all.
 *
 * ONE divergence from TEN-1 §8, recorded in REL-2 §3: TEN-1 anticipated the root
 * resolving the tenant once and passing the VALUE down to each hop. It cannot,
 * because the hop predicate lives in the generated manifest and has no call site
 * to receive it from — a hand-written `db.query.*` reaches the same relation. So
 * each hop reads the ALS itself. The result is identical (the value is constant
 * within a request) and it is what makes the predicate travel with the relation
 * rather than with the caller, which is the whole finding of §1.4.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { column } from './table-columns';
import {
  getTenantId,
  MissingUserIdError,
  requireRequester,
  tryGetRequester,
  type RequesterScope,
} from './tenant-context';

/**
 * One table's declared scope posture. Every field comes from the entity YAML —
 * `tenant_scoped:` and the `timestamps` / `soft_delete` / `user_tracking`
 * behaviors — never from inspecting the table's columns (charter I1: a
 * `'tenantId' in getColumns(table)` test would be re-deriving what the
 * declaration already says).
 *
 * The repository carries it as `BaseRepository.scopeConfig`; the manifest
 * carries it as a per-entity constant beside the edges it applies to.
 */
export type ScopeConfig = TenantAxis & {
  /** The `soft_delete` behavior — exclude rows with a `deleted_at`. */
  softDelete: boolean;
  /** The `user_tracking` behavior — filter by the ambient requester's scope. */
  userTracking: boolean;
  /** What a MISSING ambient context means: silence, or a throw. */
  enforcement: 'lenient' | 'strict';
};

/**
 * The tenant half of a scope declaration, as a union the compiler enforces:
 * `tenantColumn` is REQUIRED whenever `tenantScoped` is true and absent
 * otherwise (#791). There is no default key — a declaration that says
 * "tenant-scoped" must also say on which column, so a hand-written repository
 * cannot forget it and have `create()` drop the stamp (Drizzle ignores an
 * insert key the table does not have).
 */
export type TenantAxis =
  | {
      /** `tenant_scoped: true` — filter by the ambient tenant (ADR-042). */
      tenantScoped: true;
      /**
       * The tenant column's property key on the table — `'tenantId'` for the
       * `tenant_id` column, `'organizationId'` for `organization_id`.
       */
      tenantColumn: string;
    }
  | { tenantScoped: false; tenantColumn?: undefined };

/** A config with nothing on — no predicate, no `where` emitted for it. */
export function isUnscoped(cfg: ScopeConfig): boolean {
  return !cfg.tenantScoped && !cfg.softDelete && !cfg.userTracking;
}

/**
 * The tenant predicate for ANY table (TEN-1 §3.1 / ADR-042 §3).
 *
 *   `undefined` tenantId -> `undefined` (lenient, no context): do not scope.
 *   `null`               -> `IS NULL` (the null-tenant partition, not a wildcard).
 *   a string             -> `= tenantId`.
 *
 * `tenantColumn` is the column's property key (`'tenantId'`, `'organizationId'`, …)
 * and is required — there is no default key (#791).
 *
 * Throws (naming `owner`) when the table has no such column — a declaration
 * saying `tenant_scoped: true` over a table without the column is a query that
 * would otherwise go out with one guard silently missing.
 */
export function tenantPredicateFor(
  table: PgTable,
  tenantId: string | null | undefined,
  owner: string,
  tenantColumn: string,
): SQL | undefined {
  if (tenantId === undefined) return undefined;
  const col = column(table, tenantColumn, owner);
  return tenantId === null ? isNull(col) : eq(col, tenantId);
}

/**
 * The tenant axis for one table, GUARDED by its declared config — the form both
 * `BaseRepository.tenantPredicate()` and every hop use.
 *
 * `undefined` when the table is not tenant-scoped, when `withAllTenants(...)` is
 * in effect (a deliberate cross-tenant read), or when `lenient` and no tenant is
 * established. Under `strict` there is no third case: `getTenantId` throws rather
 * than returning `undefined`, so this either filters or raises.
 */
export function tenantAxisPredicate(
  table: PgTable,
  cfg: ScopeConfig,
  owner: string,
): SQL | undefined {
  if (!cfg.tenantScoped) return undefined;
  if (tryGetRequester()?.tenantScope === 'all') return undefined;
  return tenantPredicateFor(
    table,
    getTenantId(cfg.enforcement, owner),
    owner,
    cfg.tenantColumn,
  );
}

/**
 * The user-axis predicate for ANY table — `user_tracking`'s half of the scope.
 *
 * `'user'` -> `user_id = ctx.userId`; `'org'` -> `user_id IN ctx.orgUserIds`
 * (an empty list matches nothing — fail-closed); `'superuser'` -> no filter.
 *
 * No context at all: `lenient` -> no filter, `strict` -> throws. A context with
 * no `userId` in `'user'` scope throws `MissingUserIdError` under either
 * enforcement (#853). Every user-axis guard — root reads, by-id writes
 * (`scopeAnd`), and include hops (`hopScope`) — goes through here.
 */
export function userScopePredicateFor(
  table: PgTable,
  enforcement: 'lenient' | 'strict',
  owner: string,
): SQL | undefined {
  const ctx = enforcement === 'strict' ? requireRequester() : tryGetRequester();
  if (!ctx) return undefined;
  const scope: RequesterScope = ctx.scope ?? 'user';
  switch (scope) {
    case 'superuser':
      return undefined;
    case 'org':
      return ctx.orgUserIds && ctx.orgUserIds.length > 0
        ? inArray(column(table, 'userId', owner), ctx.orgUserIds as string[])
        : sql`false`;
    case 'user':
    default:
      // A context that IS present but carries no user (a tenant-only boundary,
      // #853) cannot scope a user-owned table in 'user' scope. That is a
      // programming error under BOTH enforcements: `lenient` relaxes only a
      // MISSING context (the `!ctx` return above), never a present one that
      // lacks the axis this table needs — reading unfiltered here would hand a
      // tenant-only caller every user's rows.
      if (ctx.userId === undefined) throw new MissingUserIdError(owner);
      return eq(column(table, 'userId', owner), ctx.userId);
  }
}

/**
 * The full scope predicate for one table: soft-delete, then the user axis, then
 * the tenant axis. `undefined` when nothing applies.
 *
 * Conjunct order is fixed (and asserted) so the SQL a query renders is stable
 * whichever of the three call sites built it.
 */
export function scopeFilter(
  table: PgTable,
  cfg: ScopeConfig,
  owner: string,
): SQL | undefined {
  const conditions: SQL[] = [];

  if (cfg.softDelete) conditions.push(isNull(column(table, 'deletedAt', owner)));

  if (cfg.userTracking) {
    const user = userScopePredicateFor(table, cfg.enforcement, owner);
    if (user) conditions.push(user);
  }

  const tenant = tenantAxisPredicate(table, cfg, owner);
  if (tenant) conditions.push(tenant);

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

/**
 * `scopeFilter`, shaped for a relation's predefined `where` — which takes a
 * `SQL`, not `SQL | undefined`. A config that resolves to nothing at runtime
 * (`user_tracking` with no ambient context under `lenient`) renders `true`
 * rather than dropping the relation's own join condition.
 *
 * This is the function the generated manifest calls, once per TRAVERSED
 * relation. A query with no include never invokes it, so root-only reads —
 * background work, lenient contexts — are untouched (REL-2 §1.2).
 */
export function hopScope(table: PgTable, cfg: ScopeConfig, owner: string): SQL {
  return scopeFilter(table, cfg, owner) ?? sql`true`;
}

/**
 * The scope of an entity that declares none — every axis off. The manifest's
 * `SCOPES` map names it explicitly for every unscoped entity table, so an
 * ABSENT key is never read as "unscoped" (READ-1 §5.1): a table missing from the
 * map is a type error at `SCOPES.<table>`, not a silent no-filter.
 */
export const UNSCOPED: ScopeConfig = Object.freeze({
  tenantScoped: false,
  softDelete: false,
  userTracking: false,
  enforcement: 'lenient',
});

/**
 * The ROOT half of a scoped read, for code that calls `db.query.<table>`
 * itself rather than going through a generated repository (READ-1 §5.2, #843).
 *
 * The relations manifest scopes every HOP of such a read; nothing scopes its
 * root. AND this into the root `where` with the table's constant from the
 * manifest's exported `SCOPES`:
 *
 * ```ts
 * await db.query.accounts.findMany({
 *   where: { AND: [{ id: { in: ids } }, scopedRoot(SCOPES.accounts, 'AccountLoader')] },
 * });
 * ```
 *
 * It is `hopScope` shaped as a filter — the same `scopeFilter` a repository's
 * root and every manifest hop use — and it renders against the handle RQBv2
 * passes the callback, i.e. the aliased root.
 */
export function scopedRoot(
  cfg: ScopeConfig,
  owner: string,
): { RAW: (table: PgTable) => SQL } {
  return { RAW: (table: PgTable) => hopScope(table, cfg, owner) };
}
