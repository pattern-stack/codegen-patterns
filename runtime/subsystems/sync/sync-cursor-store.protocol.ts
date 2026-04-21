/**
 * Sync subsystem — cursor-store protocol (port)
 *
 * Subscription-addressed cursor persistence. The subscription row IS the
 * cursor owner — addressable by id, scoped by
 * `(integration, adapter, domain, external_ref)` at the subscription level.
 *
 * Cursor shape is opaque at this seam; strategies type it internally
 * (polling: `{ systemModstamp }`, CDC: `{ replayId }`, webhook: `{ ts }`).
 * The Drizzle backend stores this as `sync_subscriptions.cursor` jsonb.
 *
 * ## Multi-tenancy (SYNC-4)
 *
 * Both methods accept an optional `tenantId`. When `SYNC_MULTI_TENANT` is
 * enabled (SYNC-6), the Drizzle backend MUST scope every read/write by
 * `tenant_id`, and a `null`/missing value throws `MissingTenantIdError` at
 * the module boundary. When the flag is off, `tenantId` is ignored.
 *
 * The in-memory backend ignores `tenantId` unconditionally — its state is
 * process-local; cross-tenant isolation there is not meaningful.
 *
 * Why a signature change instead of a tenant-proxy wrapper: multi-tenant
 * correctness bugs are silent and dangerous (cross-tenant cursor tampering).
 * An explicit signature catches omissions at the type boundary; proxies
 * hide who's enforcing. Matches JOB-8 / EVT-6 precedent — tenant ids flow
 * through input shapes, not through wrapper layers.
 */
export interface ICursorStore {
  /**
   * Return the last persisted cursor for `subscriptionId`, or `null`.
   *
   * @param tenantId  required when `SYNC_MULTI_TENANT` is on (backend
   *                  scopes the SELECT by tenant); ignored otherwise.
   */
  get(subscriptionId: string, tenantId?: string | null): Promise<unknown | null>;

  /**
   * Persist `cursor` for `subscriptionId`. Overwrites.
   *
   * The Drizzle backend also stamps `last_sync_at` + `updated_at` on the
   * same row so the scheduling index `(enabled, last_sync_at)` stays
   * accurate without consumers wrapping the port. The memory backend
   * ignores timestamps.
   *
   * @param tenantId  required when `SYNC_MULTI_TENANT` is on (backend
   *                  scopes the UPDATE by tenant); ignored otherwise.
   */
  put(
    subscriptionId: string,
    cursor: unknown,
    tenantId?: string | null,
  ): Promise<void>;
}
