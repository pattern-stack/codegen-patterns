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
import { Injectable, OnModuleDestroy, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
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
  private readonly logger = new Logger(DrizzleEventBus.name);
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
      status: 'pending',
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
        status: 'pending' as const,
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
      try {
        await this.processBatch();
      } catch (err) {
        this.logger.error(`Poll cycle error: ${err}`);
      } finally {
        this.schedulePoll();
      }
    }, POLL_INTERVAL_MS);
  }

  private async processBatch(): Promise<void> {
    // Fetch a batch of pending events with FOR UPDATE SKIP LOCKED to prevent
    // double-processing when multiple instances are polling concurrently.
    const rows = await this.db.transaction(async (tx) => {
      return tx.execute(
        sql`SELECT * FROM domain_events WHERE status = 'pending' ORDER BY occurred_at ASC LIMIT ${POLL_BATCH_SIZE} FOR UPDATE SKIP LOCKED`,
      ) as Promise<{ rows: Record<string, unknown>[] }>;
    }).then((result) => (result as unknown as { rows: Record<string, unknown>[] }).rows ?? result as unknown as Record<string, unknown>[]);

    for (const row of rows) {
      const event: DomainEvent = {
        id: row['id'] as string,
        type: row['type'] as string,
        aggregateId: row['aggregate_id'] as string,
        aggregateType: row['aggregate_type'] as string,
        payload: row['payload'] as Record<string, unknown>,
        occurredAt: new Date(row['occurred_at'] as string),
        metadata: row['metadata'] as Record<string, unknown> | undefined,
      };

      let attempt = 0;
      let lastError: unknown;
      while (attempt < MAX_RETRIES) {
        try {
          await this.dispatch(event);
          // Mark processed
          await this.db
            .update(domainEvents)
            .set({ status: 'processed', processedAt: new Date() })
            .where(eq(domainEvents.id, event.id));
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          attempt++;
        }
      }

      if (lastError !== undefined) {
        const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
        await this.db
          .update(domainEvents)
          .set({ status: 'failed', error: errorMessage })
          .where(and(eq(domainEvents.id, event.id), eq(domainEvents.status, 'pending')));
      }
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
