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
 * Scheduling (SCHED-1, ADR-039 materializer swap): under `backend: 'bullmq'`
 * the polling `EventScheduler` setInterval loop is NOT used. Instead this bus
 * registers one BullMQ **Job Scheduler** (`upsertJobScheduler`) per
 * scheduled-event type from the consumer's `eventRegistry`; each fired tick is
 * turned back into the SAME scheduled domain event via the inherited
 * `materializeScheduledEvent` (slot-key `ON CONFLICT` idempotency preserved),
 * so the time→fact→bridge→job flow is identical across backends. Reconcile on
 * boot = upsert-desired + prune-orphans (closes the ENG-605 zombie-scheduler
 * hole). Wiring happens in `onApplicationBootstrap` — AFTER every module's
 * `onModuleInit`, so the bridge's trigger registry is populated before the
 * first tick can drain (the boot-tick race the polling scheduler also avoids).
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
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
// TYPE-only — see file header. Value ctors come from `loadBullMq()`.
import type { ConnectionOptions, Queue, Worker } from 'bullmq';
import type {
  DomainEvent,
  DrizzleTransaction,
  ScheduledEventSpec,
} from './event-bus.protocol';
import { DrizzleEventBus } from './event-bus.drizzle-backend';
import type { DrizzleClient } from '../../types/drizzle';
import type { EventsModuleOptions } from './events.module';
import type { IBridgeOutboxDrainHook } from '../bridge/bridge.protocol';
import {
  scheduledEventsFromRegistry,
  slotKeyFor,
  slotStartFor,
  SCHEDULE_KEY_PREFIX,
  type ScheduledEvent,
} from './event-scheduler';

/** Logical wake-queue name. Namespaced by `queue_prefix` when several codegen
 *  apps share one Redis (mirrors jobs' `resolvePoolQueueName`). */
const EVENTS_WAKE_QUEUE = 'events-wake';

/** Logical scheduler-queue name (the BullMQ Job Schedulers + the worker that
 *  turns each fired tick into a scheduled domain event). */
const EVENTS_SCHEDULER_QUEUE = 'events-scheduler';

/** Stable per-type BullMQ Job Scheduler id. Deterministic so re-upsert is an
 *  idempotent reconcile; the `@schedule/` prefix scopes the prune sweep. */
function schedulerIdFor(type: string): string {
  return `${SCHEDULE_KEY_PREFIX}${type}`;
}

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
export class BullMQEventBus extends DrizzleEventBus implements OnApplicationBootstrap {
  // TODO(logging-subsystem): swap to ILogger once ADR-028 lands
  private readonly bullLogger = new Logger(BullMQEventBus.name);

  private readonly conn: ConnectionOptions;
  private readonly queuePrefix?: string;
  private readonly eventRegistry?: EventsModuleOptions['eventRegistry'];

  private wakeQueue: Queue | null = null;
  private wakeWorker: Worker | null = null;
  private schedulerQueue: Queue | null = null;
  private schedulerWorker: Worker | null = null;
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
    this.eventRegistry = opts?.eventRegistry;
  }

  private prefixed(name: string): string {
    return this.queuePrefix ? `${this.queuePrefix}:${name}` : name;
  }

  private wakeQueueName(): string {
    return this.prefixed(EVENTS_WAKE_QUEUE);
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
    if (this.schedulerWorker) {
      await this.schedulerWorker.close().catch(() => undefined);
      this.schedulerWorker = null;
    }
    if (this.schedulerQueue) {
      await this.schedulerQueue.close().catch(() => undefined);
      this.schedulerQueue = null;
    }
    // Reset super's polling flag / clear any (unused) super timers.
    await super.onModuleDestroy();
  }

  // ==========================================================================
  // Scheduling (SCHED-1) — BullMQ Job Scheduler materializer
  // ==========================================================================

  /**
   * Reconcile + start the BullMQ scheduler AFTER every module's `onModuleInit`
   * (so the bridge's trigger registry is populated before the first tick can
   * drain — the boot-tick race the polling `EventScheduler` avoids by deferring
   * to `onApplicationBootstrap`). Also drains any rows already pending at boot
   * now that the bridge is wired.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Drain leftover pending rows now that all hooks are attached. (The wake
    // worker is idle until the first publish; the heartbeat's first tick is
    // SAFETY_HEARTBEAT_MS away — this catches a backlog promptly + correctly.)
    await this.drainOnce().catch((err) =>
      this.bullLogger.error(`bootstrap drain failed: ${(err as Error).message}`),
    );

    if (!this.eventRegistry) return;
    const schedules = scheduledEventsFromRegistry(this.eventRegistry);
    await this.reconcileSchedulers(schedules);
    if (schedules.length > 0) await this.startSchedulerWorker();
  }

  /**
   * Upsert one BullMQ Job Scheduler per scheduled-event type (`every` ms) and
   * PRUNE orphans — schedulers present in Redis under the `@schedule/` prefix
   * that the current registry no longer declares. Reconcile-on-boot =
   * upsert-desired + prune-orphans is what structurally prevents the
   * zombie-scheduler bug class (ADR-039 ENG-605): a removed `schedule:` leaves
   * no dangling broker entry.
   */
  private async reconcileSchedulers(schedules: ScheduledEvent[]): Promise<void> {
    const queue = await this.ensureSchedulerQueue();
    const desiredIds = new Set(schedules.map((s) => schedulerIdFor(s.type)));

    for (const s of schedules) {
      await queue.upsertJobScheduler(
        schedulerIdFor(s.type),
        { every: s.everyMs },
        {
          name: 'scheduled-tick',
          data: {
            type: s.type,
            direction: s.direction,
            pool: s.pool,
            everyMs: s.everyMs,
            align: s.align,
          },
        },
      );
    }

    // Prune orphans (a removed `schedule:` → remove its broker scheduler).
    const existing = (await queue.getJobSchedulers()) as Array<{ key: string }>;
    for (const sched of existing) {
      if (sched.key.startsWith(SCHEDULE_KEY_PREFIX) && !desiredIds.has(sched.key)) {
        await queue.removeJobScheduler(sched.key);
        this.bullLogger.log(`pruned orphan scheduler '${sched.key}'`);
      }
    }
    this.bullLogger.log(
      `reconciled ${schedules.length} scheduled-event scheduler(s).`,
    );
  }

  /**
   * Worker that turns each fired scheduler tick into the SAME scheduled domain
   * event the polling path would emit. Computes the epoch-aligned slot and
   * routes through `materializeScheduledEvent` (inherited) so the slot-key
   * `ON CONFLICT` collapses any within-slot duplicate (BullMQ already emits one
   * tick per interval cluster-wide; this is the belt-and-suspenders that keeps
   * the exactly-one-event-per-slot invariant identical to the Drizzle backend).
   */
  private async startSchedulerWorker(): Promise<void> {
    await this.loadBullMq();
    const WorkerCtor = this.WorkerCtor;
    if (!WorkerCtor) throw new Error('BullMQEventBus: loadBullMq did not populate WorkerCtor');
    this.schedulerWorker = new WorkerCtor(
      this.schedulerQueueName(),
      async (job: { data: { type: string; direction: string; pool: string; everyMs: number; align?: boolean } }) => {
        const { type, direction, pool, everyMs } = job.data;
        // Epoch-aligned slot (ADR-039 align=true default). The BullMQ scheduler
        // drives the cadence; the slot key is epoch-aligned for cross-instance
        // idempotency. anchorMs is unused for the epoch-aligned path.
        const slotStart = slotStartFor(Date.now(), everyMs, true, 0);
        await this.materializeScheduledEvent({
          type,
          slotKey: slotKeyFor(type, slotStart),
          slotStart: new Date(slotStart),
          direction,
          pool,
        });
        return {};
      },
      { connection: this.conn, concurrency: 1 },
    );
    this.schedulerWorker.on('failed', (_job: unknown, err: Error) => {
      this.bullLogger.warn(`scheduler tick failed: ${err.message}`);
    });
  }

  private schedulerQueueName(): string {
    return this.prefixed(EVENTS_SCHEDULER_QUEUE);
  }

  private async ensureSchedulerQueue(): Promise<Queue> {
    if (this.schedulerQueue) return this.schedulerQueue;
    await this.loadBullMq();
    const QueueCtor = this.QueueCtor;
    if (!QueueCtor) throw new Error('BullMQEventBus: loadBullMq did not populate QueueCtor');
    this.schedulerQueue = new QueueCtor(this.schedulerQueueName(), {
      connection: this.conn,
    });
    return this.schedulerQueue;
  }

  /**
   * Materialise a scheduled tick (inherited slot-key `ON CONFLICT` insert) and,
   * when a new row was created, enqueue a wake so the tick drains promptly
   * (without it the row would wait for the safety heartbeat). Idempotent
   * repeats (`created: false`) skip the wake.
   */
  override async materializeScheduledEvent(
    spec: ScheduledEventSpec,
  ): Promise<{ created: boolean }> {
    const result = await super.materializeScheduledEvent(spec);
    if (result.created) await this.enqueueWake();
    return result;
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
