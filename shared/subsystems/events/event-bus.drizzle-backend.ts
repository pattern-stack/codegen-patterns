/**
 * DrizzleEventBus — Postgres-backed event bus using the transactional outbox pattern.
 *
 * Events are inserted into the `domain_events` table within the caller's
 * Drizzle transaction. A background polling loop (started on module init)
 * reads unprocessed events and dispatches them to registered subscribers.
 *
 * When the transaction rolls back, the event is never persisted — no
 * phantom events.
 *
 * This backend is suitable until you need real-time fan-out or very high
 * throughput. At that point, swap the backend for Redis Streams or similar
 * via EventsModule.forRoot({ backend: '...' }) without touching use cases.
 */
import { Injectable, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import { eq, isNull, and } from 'drizzle-orm';
import type { DomainEvent, DrizzleTransaction, IEventBus } from './event-bus.protocol';
import type { DrizzleClient } from '../../types/drizzle';
import { domainEvents } from './domain-events.schema';
import { DRIZZLE } from '../../constants/tokens';

/** How long to wait between polling cycles (ms). */
const POLL_INTERVAL_MS = 1_000;
/** Max events claimed per polling cycle to bound memory usage. */
const POLL_BATCH_SIZE = 50;
/** Max processing attempts before marking an event failed. */
const MAX_RETRIES = 3;

@Injectable()
export class DrizzleEventBus implements IEventBus, OnModuleInit, OnModuleDestroy {
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleClient) {}

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async onModuleInit(): Promise<void> {
    this.polling = true;
    this.schedulePoll();
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ============================================================================
  // IEventBus
  // ============================================================================

  async publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void> {
    const client = (tx ?? this.db) as DrizzleClient;
    await client.insert(domainEvents).values({
      id: event.id,
      type: event.type,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      payload: event.payload,
      occurredAt: event.occurredAt,
      processedAt: null,
      metadata: event.metadata,
    });
  }

  async publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void> {
    if (events.length === 0) return;
    const client = (tx ?? this.db) as DrizzleClient;
    await client.insert(domainEvents).values(
      events.map((e) => ({
        id: e.id,
        type: e.type,
        aggregateId: e.aggregateId,
        aggregateType: e.aggregateType,
        payload: e.payload,
        occurredAt: e.occurredAt,
        processedAt: null,
        metadata: e.metadata,
      })),
    );
  }

  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    const set = this.handlers.get(eventType)!;
    const h = handler as (event: DomainEvent) => Promise<void>;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  // ============================================================================
  // Polling
  // ============================================================================

  private schedulePoll(): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(async () => {
      await this.processBatch();
      this.schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  private async processBatch(): Promise<void> {
    // Fetch a batch of unprocessed events
    const rows = await this.db
      .select()
      .from(domainEvents)
      .where(isNull(domainEvents.processedAt))
      .limit(POLL_BATCH_SIZE);

    for (const row of rows) {
      const event: DomainEvent = {
        id: row.id,
        type: row.type,
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        metadata: row.metadata ?? undefined,
      };

      let attempt = 0;
      let lastError: unknown;
      while (attempt < MAX_RETRIES) {
        try {
          await this.dispatch(event);
          // Mark processed
          await this.db
            .update(domainEvents)
            .set({ processedAt: new Date() })
            .where(eq(domainEvents.id, row.id));
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          attempt++;
        }
      }

      if (lastError !== undefined) {
        // Mark failed by setting processedAt to a sentinel epoch date so it
        // is no longer selected by the isNull filter, but the failure is visible.
        await this.db
          .update(domainEvents)
          .set({ processedAt: new Date(0) })
          .where(and(eq(domainEvents.id, row.id), isNull(domainEvents.processedAt)));
      }
    }
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      await handler(event);
    }
  }
}
