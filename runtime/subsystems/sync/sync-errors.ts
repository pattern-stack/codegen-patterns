/**
 * Typed errors for the sync subsystem (SYNC-4).
 *
 * Classes (not bare Error) so consumers can `instanceof` them in catch
 * blocks and exception filters can map them to HTTP codes.
 *
 * Mirrors the shape of `events-errors.ts` and `jobs-errors.ts`.
 */

/**
 * Thrown by the Drizzle cursor-store / run-recorder backends when
 * `SYNC_MULTI_TENANT` is enabled but the caller did not supply a
 * non-null `tenantId`. Strict enforcement at the boundary — explicit
 * `null` still throws.
 *
 * Disable multi-tenancy on the module (`multiTenant: false`, the default)
 * to opt out of the requirement entirely.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(operation: string) {
    super(
      `Missing tenantId for sync operation '${operation}'. SyncModule is ` +
        `configured with multiTenant: true — every call must include a ` +
        `non-null tenantId. Either pass the tenantId or disable multi-` +
        `tenancy on the module.`,
    );
  }
}
