/**
 * BullMqEventSchedulerLifecycle — the BullMQ-driven scheduler for time-based
 * events (BULLMQ-2, ADR-041 option #2; ADR-039 materializer swap).
 *
 * The poll-driven cousin of `EventSchedulerLifecycle` (events.module.ts): same
 * skeleton (reconcile + prune + start on boot; close on destroy), but the
 * cadence comes from a BullMQ **Job Scheduler** (`upsertJobScheduler`) — the
 * Redis clock — instead of a `setInterval` materialiser. It is selected by
 * `events.scheduler.driver: 'bullmq'` (default `'poll'`).
 *
 * Crucially, this does NOT make BullMQ the event transport. The event bus stays
 * Drizzle + `pg_notify` (instant, transactional). This lifecycle only owns the
 * **clock**: each fired tick calls `EVENT_BUS.materializeScheduledEvent(...)`,
 * which inserts the scheduled domain event into the Postgres outbox (slot-key
 * `ON CONFLICT` idempotency) exactly as the poll driver would — the Drizzle bus
 * then drains it (`pg_notify`/poll) → bridge → job. So scheduling runs on
 * BullMQ while events run on Postgres; the two concerns are orthogonal.
 *
 * Reconcile-on-boot = upsert-desired + prune-orphans (the ENG-605
 * zombie-scheduler guard, ADR-039 §44). Wiring runs in `onApplicationBootstrap`
 * — AFTER every module's `onModuleInit`, so the bridge trigger registry is
 * populated before the first tick can drain (the boot-tick race the poll driver
 * also avoids).
 *
 * `bullmq` is an OPTIONAL peer dependency: TYPE imports only (erased at compile
 * time), value constructors load lazily via `await import('bullmq')`. The file
 * name's `.bullmq-backend.ts` suffix prunes it from non-bullmq installs
 * (`backendFileFilter`); it is NEVER re-exported from `events/index.ts` and is
 * reached only through a lazy dynamic-import factory in `EventsModule`.
 */
import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
// TYPE-only — value ctors come from `loadBullMq()`.
import type { ConnectionOptions, Queue, Worker } from 'bullmq';
import type { IEventBus } from './event-bus.protocol';
import type { EventsModuleOptions } from './events.module';
import {
  scheduledEventsFromRegistry,
  slotKeyFor,
  slotStartFor,
  SCHEDULE_KEY_PREFIX,
  type ScheduledEvent,
} from './event-scheduler';
import { ScheduleConfigError } from './events-errors';

/** Logical queue name for the BullMQ Job Schedulers + the tick worker. */
const EVENTS_SCHEDULER_QUEUE = 'events-scheduler';

/** Stable per-type BullMQ Job Scheduler id. Deterministic so re-upsert is an
 *  idempotent reconcile; the `@schedule/` prefix scopes the prune sweep. */
function schedulerIdFor(type: string): string {
  return `${SCHEDULE_KEY_PREFIX}${type}`;
}

type QueueCtor = typeof import('bullmq').Queue;
type WorkerCtor = typeof import('bullmq').Worker;

export class BullMqEventSchedulerLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  // TODO(logging-subsystem): swap to ILogger once ADR-028 lands
  private readonly logger = new Logger(BullMqEventSchedulerLifecycle.name);

  private readonly queuePrefix?: string;
  private readonly eventRegistry?: EventsModuleOptions['eventRegistry'];

  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private QueueCtor: QueueCtor | null = null;
  private WorkerCtor: WorkerCtor | null = null;
  private bullMqLoad: Promise<void> | null = null;

  constructor(
    private readonly bus: IEventBus,
    private readonly conn: ConnectionOptions,
    opts?: EventsModuleOptions,
  ) {
    this.queuePrefix = opts?.queuePrefix;
    this.eventRegistry = opts?.eventRegistry;
  }

  private queueName(): string {
    return this.queuePrefix
      ? `${this.queuePrefix}:${EVENTS_SCHEDULER_QUEUE}`
      : EVENTS_SCHEDULER_QUEUE;
  }

  /** Lazily load the optional `bullmq` package + cache its value ctors. */
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
            'The BullMQ event scheduler (events.scheduler.driver: bullmq) requires ' +
              'the "bullmq" package. Install it with: npm install bullmq',
          );
        }
      })();
    }
    await this.bullMqLoad;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.eventRegistry) return;
    if (typeof this.bus.materializeScheduledEvent !== 'function') {
      this.logger.warn(
        'events.scheduler.driver=bullmq but the event bus does not support ' +
          'materializeScheduledEvent; no scheduled events will fire.',
      );
      return;
    }
    const schedules = scheduledEventsFromRegistry(this.eventRegistry);
    await this.reconcileSchedulers(schedules);
    if (schedules.length > 0) await this.startWorker();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close().catch(() => undefined);
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close().catch(() => undefined);
      this.queue = null;
    }
  }

  /**
   * Upsert one Job Scheduler per scheduled-event type and PRUNE orphans — those
   * present in Redis under the `@schedule/` prefix the current registry no
   * longer declares. Upsert + prune is the ENG-605 zombie-scheduler guard: a
   * removed `schedule:` leaves no dangling broker entry.
   *
   * FAIL LOUD on knobs the broker scheduler cannot honour (rather than silently
   * diverging from the poll driver — ADR-039: the schedule contract is identical
   * across drivers). The broker scheduler is interval-anchored from
   * scheduler-creation and stateless across restarts, so it can only produce
   * EPOCH-aligned slots and cannot backfill:
   *   - `align: false` (anchor-relative) — the anchor can't be reconstructed.
   *   - `catchUp: true` (backfill missed slots) — the broker resumes forward only.
   * Either knob → use the poll driver.
   */
  private async reconcileSchedulers(schedules: ScheduledEvent[]): Promise<void> {
    const queue = await this.ensureQueue();
    const desiredIds = new Set(schedules.map((s) => schedulerIdFor(s.type)));

    for (const s of schedules) {
      if (!s.align) {
        throw new ScheduleConfigError(
          `event '${s.type}': schedule.align=false is not supported under ` +
            `events.scheduler.driver=bullmq (the broker scheduler is ` +
            `interval-anchored, epoch-aligned slots only). Use align: true ` +
            `(the default) or events.scheduler.driver=poll.`,
        );
      }
      if (s.catchUp) {
        throw new ScheduleConfigError(
          `event '${s.type}': schedule.catchUp is not supported under ` +
            `events.scheduler.driver=bullmq (the broker scheduler does not ` +
            `backfill missed slots). Use events.scheduler.driver=poll for catch-up.`,
        );
      }
    }

    for (const s of schedules) {
      await queue.upsertJobScheduler(
        schedulerIdFor(s.type),
        { every: s.everyMs },
        {
          name: 'scheduled-tick',
          data: { type: s.type, direction: s.direction, pool: s.pool, everyMs: s.everyMs },
        },
      );
    }

    const existing = (await queue.getJobSchedulers()) as Array<{ key: string }>;
    for (const sched of existing) {
      if (sched.key.startsWith(SCHEDULE_KEY_PREFIX) && !desiredIds.has(sched.key)) {
        await queue.removeJobScheduler(sched.key);
        this.logger.log(`pruned orphan scheduler '${sched.key}'`);
      }
    }
    this.logger.log(
      `BullMQ event scheduler reconciled ${schedules.length} scheduled event(s).`,
    );
  }

  /**
   * Worker that turns each fired tick into the SAME scheduled domain event the
   * poll driver would emit: compute the epoch-aligned slot, then
   * `bus.materializeScheduledEvent(...)` (slot-key `ON CONFLICT` insert into the
   * Postgres outbox). BullMQ emits one tick per interval cluster-wide; the
   * slot-key collapses any within-slot duplicate. The Drizzle bus drains the
   * materialised row via its own `pg_notify`/poll path → bridge → job.
   */
  private async startWorker(): Promise<void> {
    await this.loadBullMq();
    const WorkerCtor = this.WorkerCtor;
    if (!WorkerCtor) throw new Error('BullMqEventSchedulerLifecycle: loadBullMq did not populate WorkerCtor');
    this.worker = new WorkerCtor(
      this.queueName(),
      async (job: { data: { type: string; direction: string; pool: string; everyMs: number } }) => {
        const { type, direction, pool, everyMs } = job.data;
        // align is guaranteed true (reconcile rejects align:false), so the slot
        // is epoch-aligned. materializeScheduledEvent is present (guarded in
        // onApplicationBootstrap).
        const slotStart = slotStartFor(Date.now(), everyMs, true, 0);
        await this.bus.materializeScheduledEvent!({
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
    this.worker.on('failed', (_job: unknown, err: Error) => {
      this.logger.warn(`scheduled tick failed: ${err.message}`);
    });
  }

  private async ensureQueue(): Promise<Queue> {
    if (this.queue) return this.queue;
    await this.loadBullMq();
    const QueueCtor = this.QueueCtor;
    if (!QueueCtor) throw new Error('BullMqEventSchedulerLifecycle: loadBullMq did not populate QueueCtor');
    this.queue = new QueueCtor(this.queueName(), {
      connection: this.conn,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
    });
    return this.queue;
  }
}
