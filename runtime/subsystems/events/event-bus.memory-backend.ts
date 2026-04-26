/**
 * MemoryEventBus — in-memory backend for the event bus.
 *
 * Dispatches events synchronously to registered subscribers. The `tx`
 * parameter is ignored — all events are dispatched immediately.
 *
 * Use this backend in tests to assert event publication without a database.
 * Swap via EventsModule.forRoot({ backend: 'memory' }).
 *
 * Pool awareness (EVT-5):
 * - Mirrors the `DrizzleEventBus` per-process restriction (EVT-4). When
 *   `opts.pools` is set, `publish`/`publishMany` still push the event into
 *   `publishedEvents` (so test code can assert the full set of emitted
 *   events regardless of pool filter), but handlers are NOT invoked for
 *   events whose `metadata.pool` is outside the configured pools.
 * - `publishedEventsForPool(pool)` and `publishedEventsForDirection(dir)`
 *   helpers are provided for targeted assertions.
 * - Shares the `EventsModuleOptions` shape (same token as Drizzle) rather
 *   than introducing a memory-only options type — the surface is the same
 *   and keeping them unified avoids drift between backends.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DomainEvent, IEventBus } from './event-bus.protocol';
import { EVENTS_MODULE_OPTIONS } from './events.tokens';
import type { EventsModuleOptions } from './events.module';

@Injectable()
export class MemoryEventBus implements IEventBus {
  private readonly logger = new Logger(MemoryEventBus.name);

  /** All events published since construction (or last clear). */
  readonly publishedEvents: DomainEvent[] = [];

  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();
  private readonly opts: EventsModuleOptions;

  constructor(
    @Optional() @Inject(EVENTS_MODULE_OPTIONS) opts?: EventsModuleOptions,
  ) {
    // Default so direct construction (e.g. `new MemoryEventBus()` from a
    // unit test outside NestJS DI) keeps working without an explicit
    // options object.
    this.opts = opts ?? { backend: 'memory' };
  }

  async publish(event: DomainEvent): Promise<void> {
    // Mirror the `domain_events_tier_routing_check` DB constraint at the
    // memory backend boundary so misuse fails the same way regardless of
    // backend (AUDIT-1).
    this.assertTierRouting(event);

    // Always record the event — even if this process is configured with a
    // pool filter that excludes it. Test code relies on `publishedEvents`
    // being a complete log of what was published, not a filtered view.
    this.publishedEvents.push(event);

    if (this.shouldDispatch(event)) {
      await this.dispatch(event);
    }
  }

  async publishMany(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  async findById(eventId: string): Promise<DomainEvent | null> {
    return this.publishedEvents.find((e) => e.id === eventId) ?? null;
  }

  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    // Cast is safe — callers pass a typed handler; we store as the base type
    const set = this.handlers.get(eventType)!;
    const h = handler as (event: DomainEvent) => Promise<void>;
    set.add(h);

    return () => {
      set.delete(h);
    };
  }

  /** Remove all published events and subscriptions. Useful in beforeEach. */
  clear(): void {
    this.publishedEvents.length = 0;
    this.handlers.clear();
  }

  /** Filter published events by `metadata.pool`. */
  publishedEventsForPool(pool: string): DomainEvent[] {
    return this.publishedEvents.filter((e) => e.metadata?.['pool'] === pool);
  }

  /** Filter published events by `metadata.direction`. */
  publishedEventsForDirection(direction: string): DomainEvent[] {
    return this.publishedEvents.filter((e) => e.metadata?.['direction'] === direction);
  }

  /**
   * Decide whether `event` should be dispatched to handlers given the
   * current pool filter.
   *
   * Semantics (mirroring `DrizzleEventBus.processBatch`):
   * - `opts.pools` undefined  → dispatch everything (no filter).
   * - `opts.pools` empty array → treated as "no filter" to match the
   *   Drizzle backend, where `pools && pools.length > 0` is the gate on
   *   the `inArray` WHERE clause. Empty arrays dispatch everything.
   * - `opts.pools` non-empty  → dispatch only when `event.metadata.pool`
   *   is in the list. Events without `metadata.pool` do NOT match — they
   *   are out of all configured pools by definition.
   */
  private shouldDispatch(event: DomainEvent): boolean {
    const pools = this.opts.pools;
    if (!pools || pools.length === 0) return true;
    const eventPool = event.metadata?.['pool'];
    return typeof eventPool === 'string' && pools.includes(eventPool);
  }

  /**
   * Mirror the `domain_events_tier_routing_check` DB CHECK at the memory
   * backend (AUDIT-1). Audit-tier events MUST have null/undefined
   * `pool` and `direction` in metadata; the bridge dispatcher relies on
   * this invariant.
   */
  private assertTierRouting(event: DomainEvent): void {
    const tier = event.metadata?.['tier'];
    if (tier !== 'audit') return;
    const pool = event.metadata?.['pool'];
    const direction = event.metadata?.['direction'];
    const poolIsNull = pool === null || pool === undefined;
    const directionIsNull = direction === null || direction === undefined;
    if (!poolIsNull || !directionIsNull) {
      throw new Error(
        `MemoryEventBus: tier='audit' events must have null pool and direction ` +
          `(got pool=${String(pool)}, direction=${String(direction)}). ` +
          `This mirrors the domain_events CHECK constraint.`,
      );
    }
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set) return;

    let firstError: unknown;
    for (const handler of set) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(
          `Handler error for event type "${event.type}" (id: ${event.id}): ${err}`,
        );
        if (firstError === undefined) {
          firstError = err;
        }
      }
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
