/**
 * Events subsystem — protocol (port)
 *
 * IEventBus is the hexagonal port. Use cases inject this interface via
 * EVENT_BUS token. They never depend on a specific backend implementation.
 *
 * The DrizzleTransaction type mirrors what the Drizzle client exposes
 * so callers can pass a transaction for the outbox pattern.
 */
import type { DrizzleClient } from '../../types/drizzle';

// Derive the transaction type from the DrizzleClient so it stays in sync
// without introducing an additional import alias.
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient['transaction']>[0]
>[0];

// ============================================================================
// Domain event shape
// ============================================================================

export interface DomainEvent {
  /** UUID — used for deduplication and idempotency. */
  readonly id: string;
  /** Event type discriminator, e.g. 'contact_created'. */
  readonly type: string;
  /** ID of the aggregate that produced this event. */
  readonly aggregateId: string;
  /** Aggregate type name, e.g. 'contact'. */
  readonly aggregateType: string;
  /** Event-specific payload. */
  readonly payload: Record<string, unknown>;
  /** Wall-clock time the event occurred. */
  readonly occurredAt: Date;
  /** Optional routing / audit metadata. */
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// IEventBus
// ============================================================================

export interface IEventBus {
  /**
   * Publish a single domain event.
   *
   * Pass `tx` to include the event in an ongoing Drizzle transaction
   * (transactional outbox pattern). If the transaction rolls back, the
   * event is never persisted.
   */
  publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void>;

  /**
   * Publish multiple domain events atomically.
   * Same transactional semantics as `publish`.
   */
  publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void>;

  /**
   * Subscribe to events of the given type.
   * Returns an unsubscribe function — call it to remove the handler.
   */
  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void;

  /**
   * Lookup a single event by its id. Returns `null` when no event matches.
   *
   * Added in BRIDGE-5 (ADR-023 Phase 2). The bridge `BridgeDeliveryHandler`
   * uses this to re-fetch the authoritative `domain_events` row at claim
   * time so `triggers[].when` and `triggers[].map` callbacks see the
   * committed payload, not a copy that may have drifted between drain and
   * handler execution. Other consumers may use it for replay tooling and
   * audit dashboards.
   *
   * Backends:
   *   - `MemoryEventBus` — searches its in-memory `publishedEvents` log.
   *   - `DrizzleEventBus` — `SELECT … FROM domain_events WHERE id = ? LIMIT 1`.
   *   - `RedisEventBus` — Redis Pub/Sub does not retain history; returns
   *     `null` (and logs a one-time warning at first call). Bridge usage
   *     of Redis backend is unsupported.
   */
  findById(eventId: string): Promise<DomainEvent | null>;

  /**
   * Materialise exactly one scheduled tick event (ADR-039 — time as an event
   * source). Called by the framework `EventScheduler` on its boot + tick passes.
   *
   * The `slotKey` (`@schedule/<type>/<slotStartMs>`) is a pure function of
   * (type, slot) — every instance computes the same key — and is stamped onto
   * `metadata.scheduleSlot` (+ `metadata.triggerSource='schedule'`). The insert
   * is deterministic and idempotent:
   *   - Drizzle: `INSERT … ON CONFLICT DO NOTHING` against the partial UNIQUE
   *     expression index on `(type, metadata->>'scheduleSlot')`. The DB
   *     constraint — not a read, not a lock — is the exactly-one-event-per-slot
   *     invariant across multi-instance deploys and boot/tick races.
   *   - Memory: a slot-key marker set mirrors the constraint.
   *
   * Returns `created: false` when the slot event already existed (the no-op
   * case). Optional on the protocol — only the scheduler calls it, and the
   * Redis backend (no outbox history) does not implement it (the scheduler is
   * drizzle/memory only).
   */
  materializeScheduledEvent?(
    spec: ScheduledEventSpec,
  ): Promise<{ created: boolean }>;

  /**
   * Optional (ADR-039) — `occurred_at` (epoch ms) of the most recent scheduled
   * tick for `type`, or `null`. Read by the scheduler's catch-up backfill as
   * `MAX(occurred_at) WHERE type=? AND metadata->>'triggerSource'='schedule'`.
   */
  lastScheduledSlotMs?(type: string): Promise<number | null>;
}

/**
 * The fully-resolved shape the scheduler hands a backend to materialise one
 * tick. Carries the routing fields the outbox row needs (direction/pool from
 * the event's registry metadata) plus the slot key + boundary.
 */
export interface ScheduledEventSpec {
  type: string;
  /** `@schedule/<type>/<slotStartMs>` — the idempotency key. */
  slotKey: string;
  /** Slot boundary → the event's `occurred_at`. */
  slotStart: Date;
  /** `inbound | change | outbound` from the event's registry metadata. */
  direction: string;
  /** `events_inbound | events_change | events_outbound` from the registry. */
  pool: string;
}
