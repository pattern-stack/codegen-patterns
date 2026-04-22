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

/**
 * Synthetic error thrown by `MemoryBridgeDeliveryRepo.insertDelivery` when
 * a duplicate `(event_id, trigger_id)` insert hits the simulated UNIQUE
 * constraint (BRIDGE-3).
 *
 * Carries a `constraint` field equal to the Drizzle constraint name
 * declared in BRIDGE-1's schema (`uq_bridge_delivery_event_trigger`) so
 * call sites can branch on the same discriminator regardless of which
 * backend is wired up. This matters because ADR-023 explicitly leans on
 * the constraint as the dedup mechanism in two places — outbox replay
 * and `publishAndStart` Case B — and BRIDGE-4 / BRIDGE-7 will share a
 * type-check path with BRIDGE-3-driven tests.
 *
 * The Drizzle backend (BRIDGE-4) does NOT throw this error: it uses
 * `INSERT … ON CONFLICT (event_id, trigger_id) DO NOTHING RETURNING id`
 * per the BRIDGE-4 spec recommendation, so collisions surface as an empty
 * result set rather than an exception. The error exists so the memory
 * backend can faithfully model the "duplicate raises" behaviour for tests
 * that want to assert the constraint actually fires.
 */
export class UniqueConstraintError extends Error {
  override readonly name = 'UniqueConstraintError';
  constructor(
    public readonly constraint: string,
    public readonly eventId: string,
    public readonly triggerId: string,
  ) {
    super(
      `UniqueConstraintError: duplicate insert into bridge_delivery for ` +
        `(event_id='${eventId}', trigger_id='${triggerId}') — violates ` +
        `constraint '${constraint}'.`,
    );
  }
}
