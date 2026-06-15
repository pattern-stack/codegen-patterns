/**
 * BullMQEventBus — durable BullMQ-backed event bus (BULLMQ-2, ADR-041).
 *
 * Split-of-responsibility — mirrors `BullMQJobOrchestrator` exactly (Postgres
 * = source of truth, BullMQ = dispatch/wake):
 *
 *   - Postgres `domain_events` stays the **committed-event store** and the
 *     `findById` / read-port / scheduled-slot-idempotency source of truth.
 *     All of that is `DrizzleEventBus`'s job and is reused verbatim by
 *     EXTENDING it — so the bridge's single-Postgres-tx exactly-once
 *     (outbox insert + `bridge_delivery` UNIQUE + wrapper `job_run`) is
 *     preserved byte-for-byte. `publish` writes the outbox row in the
 *     caller's tx; `findById`, `listEvents`, `materializeScheduledEvent`,
 *     and `lastScheduledSlotMs` are inherited unchanged.
 *   - BullMQ owns the **wake/dispatch** half. Instead of `DrizzleEventBus`'s
 *     1s polling loop (or a `pg_notify` LISTEN connection, which needs a
 *     direct non-pooler Postgres connection — the PgBouncer caveat), `publish`
 *     enqueues a wake job onto a Redis-coordinated `events-wake` queue; a
 *     BullMQ `Worker` consumes it and drains the outbox via the inherited
 *     `drainOnce()`. This makes the wake pooler-compatible and lets several
 *     worker processes share one Redis. A slow **safety heartbeat** still
 *     drains on an interval so liveness never depends on a wake landing —
 *     critical because a Redis wake CANNOT be atomic with the Postgres commit
 *     (a wake enqueued inside the caller's tx may fire before the row is
 *     visible; the heartbeat is the correctness backstop, the wake the latency
 *     optimisation). See ADR-041 §"events on BullMQ".
 *
 * This is **additive**: the Drizzle backend, the core `IEventBus` protocol,
 * and app code are untouched. Consumers flip `events.backend: bullmq` with no
 * code change — the same `IEventBus` + `IEventReadPort` surface is satisfied.
 *
 * `bullmq` is an OPTIONAL peer dependency: TYPE imports only here (erased at
 * compile time, never resolve `'bullmq'` at runtime), value constructors load
 * lazily via `await import('bullmq')` in `loadBullMq()`. Mirrors
 * `job-orchestrator.bullmq-backend.ts:loadBullMq`. The file is filtered out of
 * non-bullmq installs (`backendFileFilter`) and is NEVER re-exported from
 * `events/index.ts` — `EventsModule.forRoot({ backend: 'bullmq' })` lazy-loads
 * it internally.
 */
import { Injectable, Logger } from '@nestjs/common';
// TYPE-only — see file header. Value ctors come from `loadBullMq()`.
import type { ConnectionOptions, Queue, Worker } from 'bullmq';
import type { DomainEvent, DrizzleTransaction } from './event-bus.protocol';
import { DrizzleEventBus } from './event-bus.drizzle-backend';
import type { DrizzleClient } from '../../types/drizzle';
import type { EventsModuleOptions } from './events.module';
import type { IBridgeOutboxDrainHook } from '../bridge/bridge.protocol';

/** Logical wake-queue name. Namespaced by `queue_prefix` when several codegen
 *  apps share one Redis (mirrors jobs' `resolvePoolQueueName`). */
const EVENTS_WAKE_QUEUE = 'events-wake';

/**
 * Safety-net drain cadence (ms). The BullMQ wake is the fast path; this
 * interval guarantees liveness when a wake is lost or fires before the
 * publishing transaction commits (the Redis-vs-Postgres atomicity gap). Far
 * slower than `DrizzleEventBus`'s 1s poll because the wake covers the common
 * case — the heartbeat only backstops the tx-publish + lost-wake tail.
 */
const SAFETY_HEARTBEAT_MS = 5_000;

/**
 * TTL (ms) for wake deduplication. A burst of publishes collapses to ~one
 * drain per window instead of one wake job per event — the drain claims a
 * whole batch anyway (`POLL_BATCH_SIZE`).
 */
const WAKE_DEDUP_TTL_MS = 250;

// Constructor types for the lazily-loaded `bullmq` value exports.
type QueueCtor = typeof import('bullmq').Queue;
type WorkerCtor = typeof import('bullmq').Worker;

@Injectable()
export class BullMQEventBus extends DrizzleEventBus {
  // TODO(logging-subsystem): swap to ILogger once ADR-028 lands
  private readonly bullLogger = new Logger(BullMQEventBus.name);

  private readonly conn: ConnectionOptions;
  private readonly queuePrefix?: string;

  private wakeQueue: Queue | null = null;
  private wakeWorker: Worker | null = null;
  private QueueCtor: QueueCtor | null = null;
  private WorkerCtor: WorkerCtor | null = null;
  private bullMqLoad: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    db: DrizzleClient,
    connection: ConnectionOptions,
    opts?: EventsModuleOptions,
    bridgeHook?: IBridgeOutboxDrainHook | null,
  ) {
    super(db, opts, bridgeHook);
    this.conn = connection;
    this.queuePrefix = opts?.queuePrefix;
  }

  private wakeQueueName(): string {
    return this.queuePrefix
      ? `${this.queuePrefix}:${EVENTS_WAKE_QUEUE}`
      : EVENTS_WAKE_QUEUE;
  }

  /**
   * Lazily load the optional `bullmq` package and cache its value
   * constructors. Idempotent (single in-flight promise). Throws a friendly,
   * actionable error when `backend: 'bullmq'` was selected but the package
   * was not installed — mirrors the jobs backend + redis backend.
   */
  private async loadBullMq(): Promise<void> {
    if (this.QueueCtor && this.WorkerCtor) return;
    if (!this.bullMqLoad) {
      this.bullMqLoad = (async () => {
        try {
          const mod = await import('bullmq');
          this.QueueCtor = mod.Queue;
          this.WorkerCtor = mod.Worker;
        } catch {
          throw new Error(
            'BullMQ events backend requires the "bullmq" package. Install it with: npm install bullmq',
          );
        }
      })();
    }
    await this.bullMqLoad;
  }

  // ==========================================================================
  // Lifecycle — BullMQ wake worker + safety heartbeat (NOT super's 1s poll)
  // ==========================================================================

  override async onModuleInit(): Promise<void> {
    // Deliberately DO NOT call super.onModuleInit() — that starts the 1s poll
    // loop (and the listen/notify path). The BullMQ wake + safety heartbeat
    // replace it. `drainOnce()` (inherited, public) runs one `processBatch`,
    // which honours `opts.pools` and the `occurred_at <= now` readiness gate.
    await this.loadBullMq();
    this.running = true;

    // Boot drain — catch rows already pending before this process started.
    await this.drainOnce().catch((err) =>
      this.bullLogger.error(`boot drain failed: ${(err as Error).message}`),
    );

    // Wake worker — one drain per wake job. Concurrency 1 serialises drains in
    // this process (FOR UPDATE SKIP LOCKED already makes cross-process drains
    // safe). The drain claims a batch, so a single wake covers many events.
    const WorkerCtor = this.WorkerCtor;
    if (!WorkerCtor) throw new Error('BullMQEventBus: loadBullMq did not populate WorkerCtor');
    this.wakeWorker = new WorkerCtor(
      this.wakeQueueName(),
      async () => {
        await this.drainOnce();
        return {};
      },
      { connection: this.conn, concurrency: 1 },
    );
    this.wakeWorker.on('failed', (_job: unknown, err: Error) => {
      this.bullLogger.warn(`wake drain failed: ${err.message}`);
    });

    // Safety heartbeat — the correctness backstop for the lost-wake / tx-publish
    // race. Unref so it never holds the process open.
    this.heartbeat = setInterval(() => {
      void this.drainOnce().catch((err) =>
        this.bullLogger.error(`heartbeat drain failed: ${(err as Error).message}`),
      );
    }, SAFETY_HEARTBEAT_MS);
    (this.heartbeat as { unref?: () => void }).unref?.();

    this.bullLogger.log(
      `BullMQEventBus started: wake-queue='${this.wakeQueueName()}', ` +
        `heartbeat=${SAFETY_HEARTBEAT_MS}ms.`,
    );
  }

  override async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.wakeWorker) {
      await this.wakeWorker.close().catch(() => undefined);
      this.wakeWorker = null;
    }
    if (this.wakeQueue) {
      await this.wakeQueue.close().catch(() => undefined);
      this.wakeQueue = null;
    }
    // Reset super's polling flag / clear any (unused) super timers.
    await super.onModuleDestroy();
  }

  // ==========================================================================
  // IEventBus — outbox insert (super) + BullMQ wake
  // ==========================================================================

  override async publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void> {
    await super.publish(event, tx);
    await this.enqueueWake();
  }

  override async publishMany(
    events: DomainEvent[],
    tx?: DrizzleTransaction,
  ): Promise<void> {
    await super.publishMany(events, tx);
    if (events.length > 0) await this.enqueueWake();
  }

  /**
   * Best-effort wake. Enqueues a deduplicated job onto the wake queue so the
   * wake worker drains the outbox. A failure here is non-fatal — the safety
   * heartbeat still drains the row, so the publish never fails on a Redis
   * hiccup (same robustness contract as the Drizzle `pg_notify` wake).
   *
   * NOTE on the tx-publish gap: when `publish` runs inside the caller's
   * transaction, this enqueue fires BEFORE the commit, so the wake worker may
   * drain before the row is visible (a no-op). The heartbeat catches the row
   * on its next tick; the bridge's wrapper-run dispatch (BRIDGE-1) does not
   * depend on this wake. Documented in ADR-041 — a Redis wake cannot be atomic
   * with a Postgres commit.
   */
  private async enqueueWake(): Promise<void> {
    try {
      const queue = await this.ensureWakeQueue();
      await queue.add(
        'wake',
        {},
        {
          removeOnComplete: true,
          removeOnFail: true,
          deduplication: { id: 'wake', ttl: WAKE_DEDUP_TTL_MS },
        },
      );
    } catch (err) {
      this.bullLogger.warn(
        `wake enqueue failed: ${(err as Error).message} ` +
          `(non-fatal — the safety heartbeat still drains the outbox).`,
      );
    }
  }

  private async ensureWakeQueue(): Promise<Queue> {
    if (this.wakeQueue) return this.wakeQueue;
    await this.loadBullMq();
    const QueueCtor = this.QueueCtor;
    if (!QueueCtor) throw new Error('BullMQEventBus: loadBullMq did not populate QueueCtor');
    this.wakeQueue = new QueueCtor(this.wakeQueueName(), { connection: this.conn });
    return this.wakeQueue;
  }
}
