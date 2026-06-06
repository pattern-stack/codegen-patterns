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
import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit, Inject, Logger, Optional } from '@nestjs/common';
import { eq, and, inArray, asc, desc, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import type {
  DomainEvent,
  DrizzleTransaction,
  IEventBus,
  ScheduledEventSpec,
} from './event-bus.protocol';
import type {
  EventPage,
  IEventReadPort,
  ListEventsQuery,
} from './event-read.protocol';
import {
  clampEventLimit,
  decodeEventCursor,
  encodeEventCursor,
} from './event-keyset-cursor';
import type { DrizzleClient } from '../../types/drizzle';
import { domainEvents, type DomainEventRecord } from './domain-events.schema';
import { DRIZZLE } from '../../constants/tokens';
import { EVENTS_MODULE_OPTIONS } from './events.tokens';
import type { EventsModuleOptions } from './events.module';
import { BRIDGE_OUTBOX_DRAIN_HOOK } from '../bridge/bridge.tokens';
import type { IBridgeOutboxDrainHook } from '../bridge/bridge.protocol';
import {
  EVENTS_WAKE_CHANNEL,
  PgNotifyListener,
  pgNotify,
} from '../jobs/pg-notify';

/** How long to wait between polling cycles (ms). */
const POLL_INTERVAL_MS = 1_000;
/** Max events claimed per polling cycle to bound memory usage. */
const POLL_BATCH_SIZE = 50;

/**
 * Row shape built from `metadata` for writing into `domain_events`. Keeps
 * the per-event extraction logic in one place so publish/publishMany stay
 * in sync.
 */
function toInsertValues(event: DomainEvent, multiTenant: boolean) {
  const metadata = event.metadata ?? undefined;
  const pool = (metadata?.['pool'] as string | undefined) ?? null;
  const direction = (metadata?.['direction'] as string | undefined) ?? null;
  // AUDIT-1: tier defaults to 'domain' when absent. The DB CHECK
  // constraint (`domain_events_tier_routing_check`) enforces the
  // tier ⇔ routing-fields invariant at the storage boundary; no
  // JS-side assertion is needed here.
  const tier = (metadata?.['tier'] as string | undefined) ?? 'domain';
  const base = {
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
    tier,
  };
  // EVT-8: `tenant_id` is a scaffold-time conditional column, emitted only
  // when `events.multi_tenant: true`. Only write it when multi-tenancy is
  // on — under single-tenant scaffolds the column does not exist, so the
  // key must be omitted from the insert.
  if (!multiTenant) return base;
  const tenantId = (metadata?.['tenantId'] as string | undefined) ?? null;
  return { ...base, tenantId };
}

/**
 * Project a raw `domain_events` row into the narrow `EventSummary` shape.
 * Shared with the memory backend via this helper kept module-local to each
 * backend (the events subsystem has no cross-backend projection file yet;
 * the two are byte-identical and small).
 */
function toEventSummary(r: DomainEventRecord) {
  const metadata = (r.metadata ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const rootRunId = metadata?.['rootRunId'];
  return {
    id: r.id,
    type: r.type,
    aggregateId: r.aggregateId,
    aggregateType: r.aggregateType,
    status: r.status,
    pool: r.pool,
    direction: r.direction,
    tier: r.tier,
    rootRunId: typeof rootRunId === 'string' ? rootRunId : null,
    // EVT-8: `tenant_id` is a scaffold-time conditional column. Read it
    // structurally so this projection typechecks against both the
    // multi-tenant schema (column present) and the single-tenant schema
    // (column absent → undefined → null).
    tenantId: (r as { tenantId?: string | null }).tenantId ?? null,
    occurredAt:
      r.occurredAt instanceof Date
        ? r.occurredAt
        : new Date(r.occurredAt as unknown as string),
    processedAt:
      r.processedAt == null
        ? null
        : r.processedAt instanceof Date
          ? r.processedAt
          : new Date(r.processedAt as unknown as string),
  };
}

/**
 * Postgres unique-violation (SQLSTATE 23505) test. Used by the scheduled-event
 * materialiser (ADR-039) to treat a slot-key collision as the
 * already-materialised no-op. Reads `.code` defensively across driver shapes
 * (node-postgres surfaces it on the error, some wrappers nest it on `.cause`).
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | undefined);
  return code?.code === '23505' || code?.cause?.code === '23505';
}

@Injectable()
export class DrizzleEventBus implements IEventBus, IEventReadPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleEventBus.name);
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();
  private readonly opts: EventsModuleOptions;

  // LISTEN-NOTIFY-1 — dedicated wake listener + debounce state. `null` when
  // `listenNotify` is off (the common case); polling is the only driver then.
  private notifyListener: PgNotifyListener | null = null;
  /** True while a wake-driven drain is in flight (debounce gate). */
  private wakeDraining = false;
  /** A notify arrived mid-drain → re-drain once when the current drain ends. */
  private wakeRecheckPending = false;

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

    // LISTEN-NOTIFY-1 — start the wake listener ALONGSIDE the poll timer. A
    // notify for one of this drainer's pools triggers an immediate drain; the
    // interval timer above stays the durability heartbeat. Startup is
    // fire-and-forget — a connect failure self-heals via the listener's backoff.
    if (this.opts.listenNotify) {
      const pool = (this.db as unknown as { $client?: unknown }).$client;
      if (!pool || typeof (pool as { connect?: unknown }).connect !== 'function') {
        this.logger.warn(
          `listen_notify enabled but the Drizzle client exposes no pg Pool ` +
            `($client.connect missing) — falling back to interval polling only.`,
        );
      } else {
        this.notifyListener = new PgNotifyListener({
          channel: EVENTS_WAKE_CHANNEL,
          pool: pool as { connect(): Promise<never> },
          label: 'events',
          onNotify: (payload) => this.onWake(payload),
        });
        await this.notifyListener.start();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.notifyListener) {
      try {
        await this.notifyListener.stop();
      } catch (err) {
        this.logger.error(`notify listener stop failed: ${err}`);
      }
      this.notifyListener = null;
    }
  }

  /**
   * Wake handler — a `codegen_events_wake` notification arrived. A pool-filtered
   * drainer (`opts.pools` set) ignores payloads naming a pool it doesn't own; an
   * all-pools drainer wakes for any. Debounced: a notify mid-drain just flags a
   * re-check so a burst collapses to at most one extra drain (D3).
   */
  private onWake(payload: string): void {
    if (!this.polling) return;
    const pools = this.opts.pools;
    if (pools && pools.length > 0 && !pools.includes(payload)) return;
    if (this.wakeDraining) {
      this.wakeRecheckPending = true;
      return;
    }
    void this.drainOnWake();
  }

  private async drainOnWake(): Promise<void> {
    this.wakeDraining = true;
    try {
      do {
        this.wakeRecheckPending = false;
        await this.processBatch();
      } while (this.wakeRecheckPending && this.polling);
    } catch (err) {
      this.logger.error(`wake drain error: ${err}`);
    } finally {
      this.wakeDraining = false;
    }
  }

  // ============================================================================
  // IEventBus
  // ============================================================================

  async publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void> {
    const client = (tx ?? this.db) as DrizzleClient;
    const multiTenant = this.opts.multiTenant ?? false;
    const values = toInsertValues(event, multiTenant);
    await client.insert(domainEvents).values(values);
    // LISTEN-NOTIFY-1 — wake the drainer on commit (D2: emitted through the same
    // `client`, so a rolled-back publish emits no phantom wake). The pool is the
    // payload; the drainer re-runs its own pool-filtered claim on wake.
    await this.emitWakeNotify(client, [values.pool]);
  }

  async publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void> {
    if (events.length === 0) return;
    const client = (tx ?? this.db) as DrizzleClient;
    const multiTenant = this.opts.multiTenant ?? false;
    const valuesList = events.map((e) => toInsertValues(e, multiTenant));
    await client.insert(domainEvents).values(valuesList);
    // De-dup pools so a batch into one lane emits a single wake.
    await this.emitWakeNotify(client, valuesList.map((v) => v.pool));
  }

  /**
   * Emit one in-tx `pg_notify(codegen_events_wake, <pool>)` per distinct pool in
   * the just-inserted batch. No-op unless `listenNotify` is on. Best-effort: a
   * notify failure is non-fatal (interval polling still drains the rows), so we
   * log + swallow rather than failing the publish.
   */
  private async emitWakeNotify(
    client: DrizzleClient,
    pools: Array<string | null>,
  ): Promise<void> {
    if (!this.opts.listenNotify) return;
    const distinct = new Set(pools.map((p) => p ?? ''));
    for (const pool of distinct) {
      try {
        await pgNotify(client, EVENTS_WAKE_CHANNEL, pool);
      } catch (err) {
        this.logger.warn(
          `pg_notify(${EVENTS_WAKE_CHANNEL}, '${pool}') failed: ${err} ` +
            `(non-fatal — interval polling still drains the outbox).`,
        );
      }
    }
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
  // ADR-039 — scheduled-event materialisation (time as an event source)
  // ============================================================================

  /**
   * Insert one scheduled tick event idempotently. The slot key is stamped onto
   * `metadata.scheduleSlot`; `ON CONFLICT DO NOTHING` against the partial UNIQUE
   * expression index `idx_domain_events_schedule_slot` makes a duplicate insert
   * a no-op — the DB constraint is the exactly-one-event-per-slot invariant.
   *
   * Reuses the standard outbox row shape (pool/direction/metadata) so the
   * existing drain carries the tick like any other event. A LISTEN/NOTIFY wake
   * fires for an immediately-due tick (boot/catch-up rows whose slot is already
   * in the past); a future slot is claimed by polling once `occurred_at` passes.
   */
  async materializeScheduledEvent(
    spec: ScheduledEventSpec,
  ): Promise<{ created: boolean }> {
    const multiTenant = this.opts.multiTenant ?? false;
    const metadata: Record<string, unknown> = {
      pool: spec.pool,
      direction: spec.direction,
      scheduleSlot: spec.slotKey,
      triggerSource: 'schedule',
    };
    const base = {
      id: randomUUID(),
      type: spec.type,
      // Payload-free scheduled fact (the dealbrain strict-producer pattern).
      aggregateId: spec.type,
      aggregateType: spec.type,
      payload: {} as Record<string, unknown>,
      occurredAt: spec.slotStart,
      processedAt: null,
      status: 'pending' as const,
      metadata,
      pool: spec.pool,
      direction: spec.direction,
      tier: 'domain' as const,
    };
    const values = multiTenant ? { ...base, tenantId: null } : base;

    // The idempotency guard is the partial UNIQUE expression index
    // `idx_domain_events_schedule_slot` on (type, metadata->>'scheduleSlot').
    // Use a BARE (no-target) `ON CONFLICT DO NOTHING`: Drizzle 0.45's typed
    // `onConflictDoNothing({ target })` only accepts columns so it can't NAME
    // the expression index, but the no-arg form emits target-less
    // `ON CONFLICT DO NOTHING`, which Postgres applies to ANY unique
    // constraint/index — including this expression index. `.returning({ id })`
    // then gives us the rowcount discriminator: zero rows back == the slot was
    // already materialised (DO NOTHING fired), so `created: false`. This keeps
    // the happy path off the exception channel — a repeat materialise no longer
    // raises SQLSTATE 23505, so Postgres logs no scary `duplicate key value
    // violates unique constraint` ERROR line on every colliding boot/tick.
    //
    // The unique-violation catch is retained as a fallback for the genuine
    // concurrent-insert race window (two sessions clear the conflict check and
    // both attempt the insert in the same instant) and for backends whose
    // driver surfaces a 23505 rather than honouring DO NOTHING; in both cases
    // it collapses to the same `created: false` no-op.
    let inserted: Array<{ id: string }>;
    try {
      inserted = await this.db
        .insert(domainEvents)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: domainEvents.id });
    } catch (err) {
      if (isUniqueViolation(err)) return { created: false };
      throw err;
    }
    if (inserted.length === 0) return { created: false };

    // Wake the drainer for an already-due tick. A future slot waits for polling.
    if (spec.slotStart.getTime() <= Date.now()) {
      await this.emitWakeNotify(this.db, [spec.pool]);
    }
    return { created: true };
  }

  /** Most recent scheduled tick's `occurred_at` (epoch ms) for `type`, or null.
   *  Read by the scheduler's catch-up backfill. */
  async lastScheduledSlotMs(type: string): Promise<number | null> {
    const rows = await this.db
      .select({ occurredAt: domainEvents.occurredAt })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, type),
          sql`${domainEvents.metadata} ->> 'triggerSource' = 'schedule'`,
        ),
      )
      .orderBy(desc(domainEvents.occurredAt))
      .limit(1);
    const row = rows[0];
    if (!row?.occurredAt) return null;
    return row.occurredAt instanceof Date
      ? row.occurredAt.getTime()
      : new Date(row.occurredAt as unknown as string).getTime();
  }

  // ============================================================================
  // IEventReadPort (OBS-LIST-1)
  // ============================================================================

  async listEvents(query: ListEventsQuery = {}): Promise<EventPage> {
    const limit = clampEventLimit(query.limit);
    const conditions: SQL<unknown>[] = [];

    if (query.poolId) conditions.push(eq(domainEvents.pool, query.poolId));
    if (query.direction)
      conditions.push(eq(domainEvents.direction, query.direction));
    if (query.since) conditions.push(gte(domainEvents.occurredAt, query.since));
    if (query.rootRunId) {
      // Filter on the JSON correlation id: metadata->>'rootRunId'.
      conditions.push(
        sql`${domainEvents.metadata}->>'rootRunId' = ${query.rootRunId}`,
      );
    }
    // EVT-8: `tenant_id` is a scaffold-time conditional column (emitted only
    // under `events.multi_tenant: true`). Guard the filter behind the same
    // `multiTenant` flag, and read the column structurally so this backend
    // typechecks against both the multi-tenant schema (column present) and
    // the single-tenant schema (column absent). When multi-tenancy is off
    // there is no `tenant_id` column to filter on.
    if (this.opts.multiTenant && query.tenantId !== undefined) {
      const tenantIdColumn = (
        domainEvents as unknown as { tenantId: typeof domainEvents.pool }
      ).tenantId;
      conditions.push(
        query.tenantId === null
          ? (sql`${tenantIdColumn} is null` as SQL<unknown>)
          : eq(tenantIdColumn, query.tenantId),
      );
    }

    // Keyset seek: WHERE (occurred_at, id) < (cursorOccurredAt, cursorId).
    if (query.cursor) {
      const keyset = decodeEventCursor(query.cursor);
      if (keyset) {
        conditions.push(
          or(
            lt(domainEvents.occurredAt, keyset.occurredAt),
            and(
              eq(domainEvents.occurredAt, keyset.occurredAt),
              lt(domainEvents.id, keyset.id),
            ),
          )!,
        );
      }
    }

    const rows = (await this.db
      .select()
      .from(domainEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
      .limit(limit + 1)) as DomainEventRecord[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toEventSummary);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeEventCursor({ occurredAt: last.occurredAt, id: last.id })
        : null;

    return { items, nextCursor };
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
