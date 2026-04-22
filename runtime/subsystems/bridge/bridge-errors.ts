/**
 * Typed errors for the bridge subsystem (ADR-023 Phase 2, BRIDGE-2).
 *
 * All thrown by the three enforcement sites named in ADR-023 §Multi-tenancy:
 *   - `EventFlowService.publishAndStart` entry (BRIDGE-7)
 *   - `BridgeDeliveryHandler.handle` entry (BRIDGE-5)
 *   - `DrizzleBridgeDeliveryRepo.insertDelivery` pre-write (BRIDGE-4)
 *
 * Same shape as `runtime/subsystems/jobs/jobs-errors.ts` and
 * `runtime/subsystems/events/events-errors.ts` so consumers can catch them
 * with the same exception-filter pattern across all three subsystems.
 */

/**
 * Thrown when `BridgeModule` was configured with `multiTenant: true` but
 * the caller did not pass a `tenantId` at one of the three enforcement
 * sites listed above.
 *
 * **Strict enforcement rationale (mirrors JOB-8 / SYNC-6 stance, locked
 * 2026-04-18 for jobs; same rationale applies here).** Cross-tenant data
 * leakage is the worst class of bug a multi-tenant system can ship;
 * surfacing the misuse loudly at the call site (rather than silently
 * defaulting to `null` or to "the last tenant seen") prevents both
 * accidental global writes and sneaky reads that return a union of tenants.
 *
 * - `undefined` `tenantId` → throw this error.
 * - Explicit `null` `tenantId` → passes; opts the call into cross-tenant
 *   work (e.g. a system housekeeping event with no owning tenant). The
 *   `bridge_delivery` row is persisted with `tenant_id = NULL`.
 *
 * The `callSite` constructor argument names which of the three enforcement
 * sites threw — review reports and ops dashboards rely on a stable site
 * name, so use the canonical strings: `'EventFlowService.publishAndStart'`,
 * `'BridgeDeliveryHandler.handle'`,
 * `'DrizzleBridgeDeliveryRepo.insertDelivery'`.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(public readonly callSite: string) {
    super(
      `MissingTenantIdError: BridgeModule was configured with ` +
        `multiTenant=true but ${callSite} was called without tenantId ` +
        `(undefined). Pass an explicit tenantId, or pass null for ` +
        `cross-tenant work.`,
    );
  }
}
