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
 * Pool awareness (EVT-4):
 * - On `publish`/`publishMany` the backend writes `metadata.pool`,
 *   `metadata.direction`, and `metadata.tenantId` into the first-class
 *   `pool` / `direction` / `tenant_id` columns (metadata JSON is still
 *   written unchanged for protocol stability).
 * - The drain loop filters by `opts.pools` when provided, so separate
 *   processes (e.g. one per `events_inbound` / `events_change` /
 *   `events_outbound`) can claim only their own lane. `pools: undefined`
 *   drains all pending rows (backwards-compatible behaviour).
 *
 * EVT-Q7: No stale-event sweeper. `FOR UPDATE SKIP LOCKED` is
 * self-healing — the row is only locked for the duration of the
 * enclosing polling transaction; the `status='processed'` update happens
 * within that same transaction. There is no `claimed_at` semantic (unlike
 * jobs), so no stale rows can exist.
 *
 * This backend is suitable until you need real-time fan-out or very high
 * throughput. At that point, swap the backend for Redis Streams or similar
 * via EventsModule.forRoot({ backend: '...' }) without touching use cases.
 */
import { Injectable, OnModuleDestroy, OnModuleInit, Inject, Logger, Optional } from '@nestjs/common';
import { eq, and, inArray, asc, type SQL } from 'drizzle-orm';
import type { DomainEvent, DrizzleTransaction, IEventBus } from './event-bus.protocol';
import type { DrizzleClient } from '../../types/drizzle';
import { domainEvents } from './domain-events.schema';
import { DRIZZLE } from '../../constants/tokens';
import { EVENTS_MODULE_OPTIONS } from './events.tokens';
import type { EventsModuleOptions } from './events.module';
import { BRIDGE_OUTBOX_DRAIN_HOOK } from '../bridge/bridge.tokens';
import type { IBridgeOutboxDrainHook } from '../bridge/bridge.protocol';

/** How long to wait between polling cycles (ms). */
const POLL_INTERVAL_MS = 1_000;
/** Max events claimed per polling cycle to bound memory usage. */
const POLL_BATCH_SIZE = 50;

/**
 * Row shape built from `metadata` for writing into `domain_events`. Keeps
 * the per-event extraction logic in one place so publish/publishMany stay
 * in sync.
 */
function toInsertValues(event: DomainEvent) {
  const metadata = event.metadata ?? undefined;
  const pool = (metadata?.['pool'] as string | undefined) ?? null;
  const direction = (metadata?.['direction'] as string | undefined) ?? null;
  const tenantId = (metadata?.['tenantId'] as string | undefined) ?? null;
  return {
    id: event.id,
    type: event.type,
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    payload: event.payload,
    occurredAt: event.occurredAt,
    processedAt: null,
    status: 'pending' as const,
    metadata: event.metadata,
    pool,
    direction,
    tenantId,
  };
}

@Injectable()
export class DrizzleEventBus implements IEventBus, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleEventBus.name);
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();
  private readonly opts: EventsModuleOptions;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() @Inject(EVENTS_MODULE_OPTIONS) opts?: EventsModuleOptions,
    /**
     * Bridge subsystem hook (BRIDGE-4). Optional — when the bridge
     * subsystem is not installed in the consuming app, this token is
     * undefined and the drain skips the bridge block entirely (preserves
     * EVT-4 baseline behaviour).
     *
     * When provided, `processEvent` is invoked once per drained event
     * INSIDE the per-event tx, before `processed_at` is stamped. The
     * hook owns all knowledge of `bridge_delivery + wrapper job_run`
     * shapes; the events subsystem stays unaware of bridge schemas.
     */
    @Optional()
    @Inject(BRIDGE_OUTBOX_DRAIN_HOOK)
    private readonly bridgeHook: IBridgeOutboxDrainHook | null = null,
  ) {
    // Default so direct construction (e.g. integration tests not going
    // through Nest DI) keeps working without an explicit options object.
    this.opts = opts ?? { backend: 'drizzle' };
  }

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
    await client.insert(domainEvents).values(toInsertValues(event));
  }

  async publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void> {
    if (events.length === 0) return;
    const client = (tx ?? this.db) as DrizzleClient;
    await client.insert(domainEvents).values(events.map(toInsertValues));
  }

  async findById(eventId: string): Promise<DomainEvent | null> {
    const rows = await this.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
      payload: row.payload as Record<string, unknown>,
      occurredAt:
        row.occurredAt instanceof Date
          ? row.occurredAt
          : new Date(row.occurredAt as unknown as string),
      metadata: (row.metadata ?? undefined) as
        | Record<string, unknown>
        | undefined,
    };
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

  /**
   * Test-only hook. Runs exactly one drain cycle and returns. Production
   * code goes through `onModuleInit` → `schedulePoll`, which calls the
   * same `processBatch` under a timer.
   */
  async drainOnce(): Promise<void> {
    await this.processBatch();
  }

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

  /**
   * Drain one batch (BRIDGE-4 restructure of EVT-4).
   *
   * Two-phase per drained event:
   *
   *   1. **Per-event transaction** — bridge fanout (`bridgeHook.processEvent`)
   *      + `processed_at` stamp. Both write through the same `tx`. A throw
   *      inside the tx (only infra-level failures should reach here, since
   *      the hook tolerates null direction and registry misses inline)
   *      rolls back the bridge inserts AND the `processed_at` stamp; the
   *      event re-claims on the next drain cycle. Bridge `UNIQUE
   *      (event_id, trigger_id)` makes the retry idempotent.
   *
   *   2. **After commit** — dispatch in-process subscribers (`IEventBus.subscribe`
   *      handlers). This deliberately runs OUTSIDE the per-event tx (lead
   *      decision 2026-04-22): subscribers are best-effort and must not
   *      gate forward progress or roll back bridge fanout. Subscriber
   *      errors are caught + logged; `processed_at` is already committed.
   *      The old `MAX_RETRIES=3` in-process retry loop and the
   *      `failed`-stamping path were removed in BRIDGE-4 along with their
   *      coupling.
   *
   * The `processed_at` UPDATE carries `AND status='pending'` (BRIDGE-4
   * tightening — without it, a hypothetical double-claim could double-stamp
   * the timestamp). The per-event tx + `FOR UPDATE SKIP LOCKED` claim
   * make this defensive belt-and-suspenders.
   */
  private async processBatch(): Promise<void> {
    const pools = this.opts.pools;

    // Build WHERE: status='pending' [AND pool IN (...)]
    const whereClause: SQL<unknown> = pools && pools.length > 0
      ? (and(eq(domainEvents.status, 'pending'), inArray(domainEvents.pool, pools)) as SQL<unknown>)
      : eq(domainEvents.status, 'pending');

    // Claim a batch with FOR UPDATE SKIP LOCKED so multiple pollers don't
    // double-dispatch. The lock is released when the outer transaction
    // commits — which is fine because the immediately-following per-event
    // tx flips status='processed' under its own `AND status='pending'`
    // guard, so a re-claim of the same row in a subsequent batch is a
    // no-op UPDATE.
    const rows = await this.db.transaction(async (tx) => {
      return tx
        .select()
        .from(domainEvents)
        .where(whereClause)
        .orderBy(asc(domainEvents.occurredAt))
        .limit(POLL_BATCH_SIZE)
        .for('update', { skipLocked: true });
    }) as Array<typeof domainEvents.$inferSelect>;

    for (const row of rows) {
      const event: DomainEvent = {
        id: row.id,
        type: row.type,
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        payload: row.payload as Record<string, unknown>,
        occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt as unknown as string),
        metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
      };

      // Phase 1 — per-event tx: bridge fanout + processed_at stamp.
      try {
        await this.db.transaction(async (tx) => {
          if (this.bridgeHook) {
            await this.bridgeHook.processEvent(event, tx);
          }
          await tx
            .update(domainEvents)
            .set({ status: 'processed', processedAt: new Date() })
            .where(
              and(
                eq(domainEvents.id, event.id),
                eq(domainEvents.status, 'pending'),
              ),
            );
        });
      } catch (err) {
        // Infra-level failure inside the per-event tx — bridge inserts
        // and processed_at both rolled back. Log and move on; the next
        // drain cycle re-claims the row. UNIQUE on bridge_delivery makes
        // the retry idempotent.
        this.logger.error(
          `Per-event tx failed for event id=${event.id} type=${event.type}: ${err}`,
        );
        continue;
      }

      // Phase 2 — best-effort subscriber dispatch. Errors are logged
      // and discarded; processed_at is already committed. Subscribers
      // are observability + cache-busts + small ancillary work; they
      // must not gate forward progress.
      try {
        await this.dispatch(event);
      } catch (err) {
        this.logger.error(
          `Subscriber dispatch failed for event id=${event.id} type=${event.type} ` +
            `(processed_at already committed; failure does not retry): ${err}`,
        );
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
