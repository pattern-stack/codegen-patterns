/**
 * `assertTenantId` — shared multi-tenancy enforcement helper for the
 * bridge subsystem (BRIDGE-8, ADR-023 §Multi-tenancy null-tenantId).
 *
 * Single source of truth for the three enforcement sites named in
 * ADR-023 §Multi-tenancy and the BRIDGE-2 spec:
 *
 *   (a) `EventFlowService.publishAndStart`           — request-path entry
 *   (b) `BridgeDeliveryHandler.run`                  — wrapper handler entry
 *   (c) `DrizzleBridgeDeliveryRepo.insertDelivery`   — last-line repo defense
 *
 * Contract (mirrors JOB-8 / SYNC-6 — locked 2026-04-18 for jobs and
 * carried into the bridge here):
 *
 *   - `multiTenant === false`           → no-op (always passes).
 *   - `multiTenant === true`,
 *      `tenantId === undefined`         → throw `MissingTenantIdError(site)`.
 *   - `multiTenant === true`,
 *      `tenantId === null`              → passes; opts the call into
 *                                          cross-tenant work (system
 *                                          housekeeping, framework events
 *                                          with no owning tenant). Persists
 *                                          to the DB as `tenant_id = NULL`.
 *   - `multiTenant === true`,
 *      `tenantId` is a string           → passes.
 *
 * The strict `undefined`-vs-`null` discrimination is the entire point —
 * silent defaulting is exactly the failure mode that lets cross-tenant
 * leaks ship.
 */
import { MissingTenantIdError } from './bridge-errors';

/**
 * Throws `MissingTenantIdError(site)` if `multiTenant === true` and
 * `tenantId === undefined`. Explicit `null` always passes.
 *
 * @param site         Canonical site name — one of:
 *                     `'EventFlowService.publishAndStart'`,
 *                     `'BridgeDeliveryHandler.run'`,
 *                     `'DrizzleBridgeDeliveryRepo.insertDelivery'`.
 *                     Stable strings; ops dashboards / review reports key
 *                     on these. Use the same string the existing tests
 *                     and `MissingTenantIdError` JSDoc enumerate.
 * @param multiTenant  Resolved `BRIDGE_MULTI_TENANT` flag (from
 *                     `BridgeModule.forRoot({ multiTenant })`).
 * @param tenantId     The tenantId the caller supplied (or didn't).
 */
export function assertTenantId(
  site: string,
  multiTenant: boolean,
  tenantId: string | null | undefined,
): void {
  if (multiTenant && tenantId === undefined) {
    throw new MissingTenantIdError(site);
  }
  // explicit null passes — opts into cross-tenant work
}
