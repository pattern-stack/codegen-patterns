/**
 * IEventReadPort — read-side port over `domain_events` (OBS-LIST-1).
 *
 * The publish/subscribe `IEventBus` (EVENT_BUS) is a *write + dispatch*
 * port; it deliberately does not expose tabular reads beyond `findById`.
 * The observability combiner needs a paginated, filterable list of
 * `domain_events` for its events viewer, so we add a dedicated read port
 * rather than overloading `IEventBus`.
 *
 * Keeping reads on a separate port means:
 *   - the combiner can compose it `@Optional()` independently of EVENT_BUS;
 *   - the Redis backend (which retains no history) simply does not provide
 *     it — there is no "list" semantics to fake;
 *   - the write/dispatch surface stays minimal.
 *
 * Both `DrizzleEventBus` and `MemoryEventBus` implement this port (they
 * already hold the rows / in-memory log); `EventsModule.forRoot` binds the
 * `EVENT_READ_PORT` token to the same instance for drizzle/memory backends.
 */

import type { DomainEvent } from './event-bus.protocol';

/**
 * Filter + keyset-pagination input for `IEventReadPort.listEvents`.
 *
 * Ordered `occurred_at DESC, id DESC`. `rootRunId` filters on the JSON
 * `metadata->>'rootRunId'` — the correlation id stamped by the jobs/bridge
 * machinery so an event can be traced back to the run tree that emitted it.
 */
export interface ListEventsQuery {
  /** Filter on `metadata->>'rootRunId'` (correlation id). */
  rootRunId?: string;
  /** Filter on the first-class `pool` column. */
  poolId?: string;
  /** Filter on the first-class `direction` column (inbound|change|outbound). */
  direction?: string;
  /** Lower bound on `occurred_at` (inclusive). */
  since?: Date;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Page size. Backend clamps to a sane default + max. */
  limit?: number;
  /**
   * Multi-tenancy filter on the first-class `tenant_id` column. Only
   * meaningful when the consumer publishes tenant-scoped events
   * (`events.multi_tenant: true`); otherwise leave undefined.
   *   - `string` — filter `tenant_id = :tenantId`.
   *   - `null`   — filter `tenant_id IS NULL`.
   *   - `undefined` — no tenant filter.
   */
  tenantId?: string | null;
}

/**
 * Summary row for the events list. A narrow projection over `domain_events`
 * carrying what the viewer + correlation timeline need. `rootRunId` is
 * surfaced (lifted out of `metadata`) so the timeline can stitch without a
 * second metadata dig.
 */
export interface EventSummary {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  status: string;
  pool: string | null;
  direction: string | null;
  tier: string;
  rootRunId: string | null;
  tenantId: string | null;
  occurredAt: Date;
  processedAt: Date | null;
}

/**
 * One page of `listEvents` results. `nextCursor` is `null` when there are
 * no more rows.
 */
export interface EventPage {
  items: EventSummary[];
  nextCursor: string | null;
}

export interface IEventReadPort {
  /**
   * Paginated, filterable list of `domain_events` (OBS-LIST-1). Newest
   * first (`occurred_at` desc, `id` desc keyset tie-break). Returns an
   * `EventPage` with an opaque `nextCursor` for keyset pagination.
   */
  listEvents(query?: ListEventsQuery): Promise<EventPage>;
}

/** A `DomainEvent` whose metadata may carry a `rootRunId` correlation id. */
export function rootRunIdOf(event: DomainEvent): string | null {
  const v = event.metadata?.['rootRunId'];
  return typeof v === 'string' ? v : null;
}
