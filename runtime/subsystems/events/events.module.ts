/**
 * EventsModule — DynamicModule factory for the event bus subsystem.
 *
 * Register once in AppModule:
 * ```typescript
 * @Module({
 *   imports: [
 *     EventsModule.forRoot({ backend: 'drizzle' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Tests swap to the memory backend without touching application code:
 * ```typescript
 * Test.createTestingModule({
 *   imports: [EventsModule.forRoot({ backend: 'memory' })],
 * });
 * ```
 *
 * Backends (ADR-041): `drizzle` (transactional outbox, the durable default;
 * instant-on-commit via `pg_notify` when `listenNotify: true`) and `memory`
 * (tests). The event bus deliberately does NOT run on BullMQ — a Redis enqueue
 * cannot be atomic with a Postgres commit, so events stay on the outbox
 * (instant + transactional). BullMQ's role is the *jobs executor* and the
 * *scheduler clock* (below), not the event transport. The old fire-and-forget
 * `RedisEventBus` was deleted (no history, bridge/scheduler-incompatible).
 *
 * Scheduling (ADR-039) — the cadence/clock for time-based events is selected by
 * `scheduler.driver`:
 *   - `'poll'` (default) — the in-process `EventScheduler` `setInterval`
 *     materialiser.
 *   - `'bullmq'` — a BullMQ Job Scheduler (`event-scheduler.bullmq-backend.ts`)
 *     drives the cadence (the Redis clock) and emits the SAME scheduled domain
 *     event into the (Drizzle) outbox. So cron runs on BullMQ while events run
 *     on Postgres — the two concerns are orthogonal.
 *
 * Per-pool drain isolation (EVT-4):
 * ```typescript
 * EventsModule.forRoot({ backend: 'drizzle', pools: ['events_change'] });
 * ```
 *
 * Typed facade + multi-tenancy (EVT-6):
 * - `TYPED_EVENT_BUS` resolves to the generated `TypedEventBus` wrapping the
 *   selected backend.
 * - `multiTenant: true` makes `TypedEventBus.publish` throw
 *   `MissingTenantIdError` when the caller forgets `metadata.tenantId`.
 *
 * `global: true` means entity modules do not need to import EventsModule
 * individually.
 */
import {
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
  type Type,
} from '@nestjs/common';
import {
  EVENT_BUS,
  EVENT_READ_PORT,
  EVENTS_BULLMQ_CONNECTION,
  EVENTS_MODULE_OPTIONS,
  EVENTS_MULTI_TENANT,
  TYPED_EVENT_BUS,
} from './events.tokens';
import { DRIZZLE } from '../../constants/tokens';
import { BRIDGE_OUTBOX_DRAIN_HOOK } from '../bridge/bridge.tokens';
import type { DrizzleClient } from '../../types/drizzle';
import { DrizzleEventBus } from './event-bus.drizzle-backend';
import { MemoryEventBus } from './event-bus.memory-backend';
import type { IEventBus } from './event-bus.protocol';
import {
  EventScheduler,
  scheduledEventsFromRegistry,
  type RegistrySchedule,
} from './event-scheduler';
import { TypedEventBus } from './generated/bus';

/**
 * BullMQ/ioredis connection shape for the `bullmq` SCHEDULER driver (ADR-041).
 * A local structural alias — this module ships into EVERY events install
 * (incl. poll-only) and must NOT need the `bullmq` peer dep resolved by the
 * consumer's tsc. The lazily-loaded scheduler treats it as the real
 * `ConnectionOptions`.
 */
type EventsBullMqConnection = { url?: string; [key: string]: unknown };

/** Shape of the lazily-loaded BullMQ scheduler lifecycle (driven manually by
 *  the `EventSchedulerLifecycle` dispatcher). */
interface BullMqSchedulerHandle {
  onApplicationBootstrap(): Promise<void>;
  onModuleDestroy(): Promise<void>;
}

/**
 * Lazy-load the BullMQ scheduler driver. Routed through a non-literal specifier
 * so the consumer's `tsc` doesn't resolve `./event-scheduler.bullmq-backend` at
 * type-check time — that file is filtered out of poll-only installs (the
 * `.bullmq-backend.ts` suffix filter) and carries the optional `bullmq`
 * peer-dep type surface. Mirrors the jobs orchestrator's lazy load.
 */
async function loadBullMqScheduler(): Promise<
  new (
    bus: IEventBus,
    connection: EventsBullMqConnection,
    opts?: EventsModuleOptions,
  ) => BullMqSchedulerHandle
> {
  const specifier = './event-scheduler.bullmq-backend';
  const mod = (await import(specifier)) as {
    BullMqEventSchedulerLifecycle: new (
      bus: IEventBus,
      connection: EventsBullMqConnection,
      opts?: EventsModuleOptions,
    ) => BullMqSchedulerHandle;
  };
  return mod.BullMqEventSchedulerLifecycle;
}

/**
 * Resolve the BullMQ scheduler connection: explicit `options.redisUrl` →
 * `REDIS_URL` env → `redis://localhost:6379`. Same precedence as the jobs
 * subsystem's `resolveBullMqConfig`, so jobs + the events scheduler share one
 * Redis by default. Only consulted when `scheduler.driver: 'bullmq'`.
 */
function resolveEventsBullMqConnection(
  options: EventsModuleOptions,
): EventsBullMqConnection {
  return {
    url: options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  };
}

export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory';
  /**
   * Scheduling driver (ADR-041). `'poll'` (default) uses the in-process
   * `EventScheduler` `setInterval`; `'bullmq'` uses a BullMQ Job Scheduler (the
   * Redis clock) that emits the same scheduled domain event into the outbox.
   * Orthogonal to `backend` — events stay on Postgres while cron runs on BullMQ.
   */
  scheduler?: { driver?: 'poll' | 'bullmq' };
  /**
   * Redis connection URL for the `bullmq` scheduler driver. Falls back to the
   * `REDIS_URL` environment variable, then `redis://localhost:6379`. Shares the
   * env default with the jobs subsystem so both land on one Redis. Only
   * consulted when `scheduler.driver: 'bullmq'`.
   */
  redisUrl?: string;
  /**
   * Optional queue-name prefix for the BullMQ scheduler queue, so several
   * codegen apps can share one Redis without collisions (mirrors
   * `jobs.extensions.bullmq.queue_prefix`). Only consulted when
   * `scheduler.driver: 'bullmq'`.
   */
  queuePrefix?: string;
  /**
   * Restrict the drain loop to these pools. Each pool name matches the
   * `domain_events.pool` column. Leave undefined to drain all pending rows.
   * Typical lane split: one process per `events_inbound` / `events_change` /
   * `events_outbound` (see ADR-022).
   */
  pools?: string[];
  /**
   * LISTEN-NOTIFY-1 — when `true` (drizzle backend), the drainer holds a
   * dedicated listener connection and LISTENs on `codegen_events_wake`; each
   * `publish` emits an in-tx `pg_notify` so the drainer wakes the instant the
   * publishing transaction commits (instant-on-commit). Polling continues as
   * the heartbeat. Requires a direct (non-transaction-pooler) connection — see
   * the events/jobs config block re: PgBouncer. Ignored by the memory backend.
   */
  listenNotify?: boolean;
  /**
   * Multi-tenancy opt-in (EVT-6). When `true`, every `TypedEventBus.publish()`
   * must supply `opts.metadata.tenantId` — else it throws `MissingTenantIdError`.
   * Defaults to `false`.
   */
  multiTenant?: boolean;
  /**
   * The generated `TypedEventBus` class to bind to `TYPED_EVENT_BUS`
   * (ADR-037 package mode threads the consumer's generated class). Omitted ⇒
   * the bundled `./generated/bus` (which IS the consumer's file in a vendored
   * tree). Only consulted by `forRoot`.
   */
  typedBus?: Type<unknown>;
  /**
   * ADR-039 — the consumer's generated `eventRegistry`, threaded so the
   * scheduler can read the `schedule:` block + routing metadata of every
   * scheduled event. Omitted ⇒ no scheduler is spawned.
   */
  eventRegistry?: Record<
    string,
    { schedule?: RegistrySchedule; direction: string | null; pool: string | null }
  >;
}

/**
 * Scheduler lifecycle dispatcher (ADR-039 / ADR-041). Registered on every
 * `forRoot`/`forRootAsync` branch; at `onApplicationBootstrap` it reads
 * `options.scheduler.driver` and starts EITHER the in-process `EventScheduler`
 * (`'poll'`, default) OR the BullMQ Job Scheduler driver (`'bullmq'`, lazily
 * loaded so the optional `bullmq` peer dep is never resolved on a poll-only
 * install). Both emit the same scheduled domain event into the outbox; exactly
 * one runs per process.
 *
 * **Why `onApplicationBootstrap`, not `onModuleInit` (boot-tick race fix).**
 * `start()` materialises the current slot's `domain_events` row; with
 * `listenNotify` the drain consumes it within ms — so it MUST NOT run until
 * every other module (notably `BridgeModule`) has attached its outbox hooks.
 * `onModuleInit` fires during EVENTS' own init, BEFORE later modules; the boot
 * tick then drained with ZERO `bridge_delivery` rows (verified in swe-brain
 * 0.20.1). `onApplicationBootstrap` fires after all `onModuleInit` complete.
 */
@Injectable()
export class EventSchedulerLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventSchedulerLifecycle.name);
  private scheduler: EventScheduler | null = null;
  private bullmq: BullMqSchedulerHandle | null = null;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional()
    @Inject(EVENTS_MODULE_OPTIONS)
    private readonly opts: EventsModuleOptions | null = null,
    // Present (resolved) only when scheduler.driver: 'bullmq'; @Optional so the
    // poll path never requires it.
    @Optional()
    @Inject(EVENTS_BULLMQ_CONNECTION)
    private readonly conn: EventsBullMqConnection | null = null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const registry = this.opts?.eventRegistry;
    if (!registry) return;
    if (typeof this.bus.materializeScheduledEvent !== 'function') return;
    const schedules = scheduledEventsFromRegistry(registry);
    if (schedules.length === 0) return;

    if (this.opts?.scheduler?.driver === 'bullmq') {
      // BullMQ clock → same materialize path into the (Drizzle) outbox.
      const Lifecycle = await loadBullMqScheduler();
      this.bullmq = new Lifecycle(
        this.bus,
        this.conn ?? resolveEventsBullMqConnection(this.opts ?? { backend: 'drizzle' }),
        this.opts ?? undefined,
      );
      await this.bullmq.onApplicationBootstrap();
      this.logger.log(
        `EventScheduler (bullmq driver) wired for ${schedules.length} scheduled event(s).`,
      );
      return;
    }

    this.scheduler = new EventScheduler(this.bus, schedules);
    await this.scheduler.start();
    this.logger.log(
      `EventScheduler (poll driver) wired for ${schedules.length} scheduled event(s).`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    if (this.bullmq) {
      await this.bullmq.onModuleDestroy();
      this.bullmq = null;
    }
  }
}

export interface EventsModuleAsyncOptions {
  useFactory: (...args: unknown[]) => Promise<EventsModuleOptions> | EventsModuleOptions;
  inject?: unknown[];
  imports?: unknown[];
}

/**
 * Shared provider set: `TypedEventBus`, the `TYPED_EVENT_BUS` binding, and the
 * resolved `EVENTS_MULTI_TENANT` flag. One place so every branch agrees.
 */
function buildTypedBusProviders(
  multiTenant: boolean,
  typedBus?: Type<unknown>,
): Provider[] {
  const BusClass = typedBus ?? TypedEventBus;
  return [
    BusClass,
    { provide: TYPED_EVENT_BUS, useExisting: BusClass },
    { provide: EVENTS_MULTI_TENANT, useValue: multiTenant },
  ];
}

/**
 * Construct the backend for the async path. DRIZZLE is optional at inject time
 * so memory-backend consumers need not import DatabaseModule; if drizzle is
 * selected without it, throw a clear error rather than a broken bus.
 */
async function buildEventBusAsync(
  options: EventsModuleOptions,
  db: DrizzleClient | null,
  bridgeHook: unknown,
): Promise<unknown> {
  if (options.backend === 'drizzle') {
    if (!db) {
      throw new Error(
        "EventsModule.forRootAsync: backend: 'drizzle' selected but DRIZZLE provider is not available. " +
          'Ensure DatabaseModule (or another provider exposing DRIZZLE) is imported before EventsModule.forRootAsync.',
      );
    }
    return new DrizzleEventBus(db, options, bridgeHook as never);
  }
  if (options.backend === 'memory') return new MemoryEventBus(options);
  throw new Error(
    `EventsModule.forRootAsync: unknown backend '${String(options.backend)}'. ` +
      `Expected 'drizzle' | 'memory'.`,
  );
}

@Module({})
export class EventsModule {
  static forRootAsync(asyncOptions: EventsModuleAsyncOptions): DynamicModule {
    return {
      module: EventsModule,
      global: true,
      imports: (asyncOptions.imports ?? []) as Parameters<typeof Module>[0]['imports'],
      providers: [
        {
          provide: EVENTS_MODULE_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: (asyncOptions.inject ?? []) as (string | symbol | Function)[],
        },
        {
          provide: EVENTS_MULTI_TENANT,
          useFactory: (options: EventsModuleOptions) => options.multiTenant ?? false,
          inject: [EVENTS_MODULE_OPTIONS],
        },
        {
          // For the bullmq scheduler driver (harmless when driver: 'poll').
          provide: EVENTS_BULLMQ_CONNECTION,
          useFactory: (options: EventsModuleOptions) =>
            resolveEventsBullMqConnection(options),
          inject: [EVENTS_MODULE_OPTIONS],
        },
        {
          provide: EVENT_BUS,
          useFactory: (
            options: EventsModuleOptions,
            db: DrizzleClient | null,
            bridgeHook: unknown,
          ) => buildEventBusAsync(options, db, bridgeHook),
          inject: [
            EVENTS_MODULE_OPTIONS,
            { token: DRIZZLE, optional: true },
            { token: BRIDGE_OUTBOX_DRAIN_HOOK, optional: true },
          ],
        },
        // Read port (OBS-LIST-1): drizzle + memory implement IEventReadPort on
        // the EVENT_BUS instance.
        { provide: EVENT_READ_PORT, useExisting: EVENT_BUS },
        // ADR-039/ADR-041 — scheduler dispatcher (poll | bullmq per options).
        EventSchedulerLifecycle,
        TypedEventBus,
        { provide: TYPED_EVENT_BUS, useExisting: TypedEventBus },
      ],
      exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
    };
  }

  static forRoot(
    options: EventsModuleOptions = { backend: 'drizzle' },
  ): DynamicModule {
    const multiTenant = options.multiTenant ?? false;

    if (options.backend !== 'drizzle' && options.backend !== 'memory') {
      // Throw rather than silently falling back (the events backend isn't
      // Zod-validated, so a typo would otherwise boot the wrong backend).
      throw new Error(
        `EventsModule.forRoot: unknown backend '${String(options.backend)}'. ` +
          `Expected 'drizzle' | 'memory'.`,
      );
    }

    const provider =
      options.backend === 'drizzle'
        ? { provide: EVENT_BUS, useClass: DrizzleEventBus }
        : { provide: EVENT_BUS, useClass: MemoryEventBus };

    return {
      module: EventsModule,
      global: true,
      providers: [
        { provide: EVENTS_MODULE_OPTIONS, useValue: options },
        provider,
        { provide: EVENT_READ_PORT, useExisting: EVENT_BUS },
        // For the bullmq scheduler driver (harmless when driver: 'poll').
        {
          provide: EVENTS_BULLMQ_CONNECTION,
          useValue: resolveEventsBullMqConnection(options),
        },
        // ADR-039/ADR-041 — scheduler dispatcher (poll | bullmq per options).
        // No-op unless `eventRegistry` was threaded AND some event declared
        // `schedule:`.
        EventSchedulerLifecycle,
        ...buildTypedBusProviders(multiTenant, options.typedBus),
      ],
      exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
    };
  }
}
