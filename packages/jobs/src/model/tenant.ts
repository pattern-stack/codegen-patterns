/**
 * The tenant a run belongs to is a required string: every result, cache entry, limiter bucket and dedupe key is scoped
 * by it. A single-tenant app, and cross-tenant housekeeping, use `SYSTEM_TENANT`, never null: a null tenant would make
 * the one-open-run-per-dedupe-key index let duplicates through (nulls never collide) and the composite tenant FKs check
 * nothing. Codegen's generated apps start their system and single-tenant runs under it.
 */
export const SYSTEM_TENANT = '__system__';

/** Refuses a run without a tenant: an empty or missing `tenantId` is a definition error at the caller, never a run. */
export function assertTenant(tenantId: unknown, where: string): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.length === 0)
    throw new TypeError(
      `${where}: a run needs a tenant (a non-empty tenantId); a single-tenant app or system work uses SYSTEM_TENANT`,
    );
}
