/**
 * Typed errors for the events subsystem (ADR-024, EVT-6).
 *
 * All thrown from the publish path of `TypedEventBus`. They exist as
 * classes so consumers can `instanceof` them in catch blocks and
 * exception filters can map them to HTTP codes.
 */

/**
 * Thrown by `TypedEventBus.publish()` when the EventsModule is configured
 * with `multiTenant: true` and the caller did not supply
 * `opts.metadata.tenantId`. Multi-tenant mode requires every outbox row to
 * be attributable to a tenant — the `domain_events.tenant_id` column is
 * populated from this value and the drain loop uses it for future
 * tenant-scoped filtering (deferred — see ADR-024 §Multi-tenancy).
 *
 * Disable multi-tenancy at the module level (`multiTenant: false`, the
 * default) to opt out of the requirement entirely.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';
  constructor(public readonly eventType: string) {
    super(
      `Missing tenantId for event '${eventType}'. EventsModule is configured ` +
        `with multiTenant: true — every publish must include ` +
        `opts.metadata.tenantId. Either pass the tenantId or disable ` +
        `multi-tenancy on the module.`,
    );
  }
}

/**
 * Thrown (ADR-039) when a scheduled event's `schedule` config is invalid at
 * runtime — a malformed `schedule.every` duration, or a scheduled event with no
 * direction/pool to route by. Codegen validates `schedule` at `gen-all` time;
 * this is the boot backstop for a hand-edited registry or version skew. Raised
 * by `EventScheduler` construction / `parseEvery`.
 */
export class ScheduleConfigError extends Error {
  override readonly name = 'ScheduleConfigError';
  constructor(message: string) {
    super(`ScheduleConfigError: ${message}`);
  }
}
