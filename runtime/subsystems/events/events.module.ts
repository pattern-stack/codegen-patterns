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
 * Per-pool drain isolation (EVT-4):
 * ```typescript
 * EventsModule.forRoot({ backend: 'drizzle', pools: ['events_change'] });
 * ```
 * Each process restricts its drain loop to the pools listed here. `pools`
 * is undefined by default → drain all pending rows (backwards-compatible).
 *
 * Typed facade + multi-tenancy (EVT-6):
 * - `TYPED_EVENT_BUS` resolves to the generated `TypedEventBus` wrapping
 *   whichever backend is selected.
 * - `multiTenant: true` makes `TypedEventBus.publish` throw
 *   `MissingTenantIdError` when the caller forgets `metadata.tenantId`.
 *
 * `global: true` means entity modules do not need to import EventsModule
 * individually — the EVENT_BUS and TYPED_EVENT_BUS tokens are available
 * project-wide.
 *
 * Async configuration (`forRootAsync`):
 * The async factory returns `EventsModuleOptions`; the EVENT_BUS provider
 * then receives its backend dependencies — DRIZZLE for the drizzle and
 * bullmq backends, EVENTS_BULLMQ_CONNECTION for the bullmq backend, the
 * resolved options for the memory backend — through a proper `useFactory`
 * so Nest DI wires them correctly. Earlier revisions hand-constructed
 * backends with `new Class()` which silently left `db` undefined
 * (issue #108).
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
 * BullMQ/ioredis connection shape passed to `BullMQEventBus` (ADR-041). A
 * local structural alias — this module ships into EVERY events install
 * (drizzle/memory included) and must NOT need the `bullmq` peer dep resolved
 * by the consumer's tsc. The backend internally treats it as the real
 * `ConnectionOptions`.
 */
type EventsBullMqConnection = { url?: string; [key: string]: unknown };

/**
 * Lazy-load the BullMQ backend. Routed through a non-literal specifier so the
 * consumer's `tsc` doesn't resolve `./event-bus.bullmq-backend` at type-check
 * time — that file is filtered out of drizzle/memory installs (#6,
 * `backendFileFilter`) and carries the optional `bullmq` peer-dep type surface.
 * Mirrors the jobs orchestrator's lazy load.
 */
async function loadBullMqEventBus(): Promise<
  new (
    db: DrizzleClient,
    connection: EventsBullMqConnection,
    opts?: EventsModuleOptions,
    bridgeHook?: unknown,
  ) => object
> {
  const specifier = './event-bus.bullmq-backend';
  const mod = (await import(specifier)) as {
    BullMQEventBus: new (
      db: DrizzleClient,
      connection: EventsBullMqConnection,
      opts?: EventsModuleOptions,
      bridgeHook?: unknown,
    ) => object;
  };
  return mod.BullMQEventBus;
}

/**
 * Resolve the BullMQ connection: explicit `options.redisUrl` → `REDIS_URL`
 * env → `redis://localhost:6379`. Same precedence as the jobs subsystem's
 * `resolveBullMqConfig`, so jobs + events share one Redis by default.
 */
function resolveEventsBullMqConnection(
  options: EventsModuleOptions,
): EventsBullMqConnection {
  return {
    url: options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  };
}

export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'bullmq';
  /**
   * Redis connection URL used when `backend` is `'bullmq'` (ADR-041 — durable
   * dispatch over the Postgres outbox via a BullMQ wake queue). Falls back to
   * the `REDIS_URL` environment variable, then `redis://localhost:6379`. Shares
   * the env default with the jobs subsystem so both compose on one Redis.
   */
  redisUrl?: string;
  /**
   * Optional queue-name prefix for the BullMQ wake queue, so several codegen
   * apps can share one Redis without collisions (mirrors
   * `jobs.extensions.bullmq.queue_prefix`). Only consulted when
   * `backend: 'bullmq'`.
   */
  queuePrefix?: string;
  /**
   * Restrict the drain loop to these pools. Each pool name matches the
   * `domain_events.pool` column (populated from `event.metadata.pool` at
   * publish time). Leave undefined to drain all pending rows.
   *
   * Typical lane split: one process per `events_inbound` /
   * `events_change` / `events_outbound` so a slow outbound handler
   * cannot stall change-event propagation (see ADR-022).
   */
  pools?: string[];
  /**
   * LISTEN-NOTIFY-1 — when `true` (drizzle backend only), the drainer holds a
   * dedicated listener connection and LISTENs on `codegen_events_wake`. Each
   * `publish`/`publishMany` emits an in-tx `pg_notify(codegen_events_wake,
   * <pool>)` so the drainer wakes the moment the publishing transaction commits,
   * instead of waiting for the next poll tick. Polling continues unchanged as
   * the fallback heartbeat; a lost notify degrades to poll latency, never to
   * lost work. Defaults to `false`.
   *
   * Ignored by the memory + bullmq backends (memory dispatches inline; bullmq
   * has its own BullMQ wake queue, which — unlike LISTEN/NOTIFY — works through
   * a transaction pooler). Requires a direct (non-transaction-pooler)
   * connection — see the events/jobs config block re: PgBouncer.
   */
  listenNotify?: boolean;
  /**
   * Multi-tenancy opt-in (EVT-6).
   *
   * When `true`, every `TypedEventBus.publish()` call must supply
   * `opts.metadata.tenantId` — otherwise it throws `MissingTenantIdError`.
   * The tenantId is preserved on `event.metadata` and, for the Drizzle
   * backend, written to `domain_events.tenant_id` (EVT-4).
   *
   * Drain-side tenant filtering is deferred — the tenant-context model
   * (per-process vs. per-request vs. async-local-storage) is still
   * unsettled; see ADR-024 §Multi-tenancy. Only the publish-side
   * requirement ships here.
   *
   * Defaults to `false`.
   */
  multiTenant?: boolean;
  /**
   * The generated `TypedEventBus` class to bind to `TYPED_EVENT_BUS`.
   *
   * **Package mode (ADR-037).** When the runtime is imported from
   * `@pattern-stack/codegen` (not vendored), the bundled `./generated/bus`
   * `TypedEventBus` is typed to an EMPTY event union and reads the bundled
   * empty `eventRegistry` — a consumer's `events/*.yaml` are scanned into
   * `src/generated/events/bus.ts` (typed to THEIR union, reading THEIR
   * registry), which the package can't import. The generated subsystem barrel
   * therefore threads that class in here:
   * `EventsModule.forRoot({ ..., typedBus: TypedEventBus })`. Nest constructs
   * it with this module's `EVENT_BUS` + `EVENTS_MULTI_TENANT` providers (the
   * generated class injects the same string-valued tokens, which match across
   * the package boundary).
   *
   * Omitted (vendored mode / tests) ⇒ falls back to the bundled
   * `./generated/bus`, which in a vendored tree IS the consumer's generated
   * file. Without this, a package-mode consumer's typed `publish<'…'>()` calls
   * resolve against the empty union and their events never get the right
   * `pool` / `direction` stamped.
   *
   * Only consulted by `forRoot` (the path the barrel emits); `forRootAsync`
   * keeps the bundled bus.
   */
  typedBus?: Type<unknown>;
  /**
   * ADR-039 — the consumer's generated `eventRegistry`, threaded so the
   * `EventScheduler` can read the `schedule:` block + routing metadata of every
   * scheduled event. Package mode: the generated subsystem barrel passes the
   * consumer's `eventRegistry` (the bundled one is the package's empty/fixture
   * registry, which the package can't see the consumer's events through — same
   * reason `typedBus` is threaded). Omitted ⇒ no scheduler is spawned (vendored
   * tree reads its own bundled registry only if the barrel passes it; tests
   * pass a registry directly).
   *
   * Structural shape: each value needs `schedule?` + `direction` + `pool`. The
   * generated `EventMetadata` satisfies it; typing it loosely here avoids a
   * runtime dependency on the generated types from the module file.
   */
  eventRegistry?: Record<
    string,
    { schedule?: RegistrySchedule; direction: string | null; pool: string | null }
  >;
}

/**
 * Lifecycle holder for the `EventScheduler` (ADR-039). Registered as a provider
 * on the drizzle/memory `forRoot` branches. Reads the scheduled-event set from
 * the threaded `eventRegistry` and starts the materialiser. No-op when nothing
 * declared `schedule:`. Added only on the drizzle/memory `forRoot` branches —
 * the bullmq backend owns scheduling via the BullMQ Job Scheduler (SCHED-1),
 * not this polling loop (ADR-041: one scheduler source of truth per backend).
 *
 * **Why `onApplicationBootstrap`, not `onModuleInit` (boot-tick race fix).**
 * `start()` runs `materializeBoot()`, which inserts the current slot's
 * `domain_events` row. With `listenNotify` enabled the outbox drain consumes
 * that row within milliseconds — so it MUST NOT run until every other module
 * has attached its outbox hooks. `onModuleInit` fires during the EVENTS
 * module's own init, BEFORE later modules (notably `BridgeModule`, which
 * attaches the bridge outbox-drain hook) finish initialising. The result was a
 * silent boot-only loss: the boot tick drained to `processed` with ZERO
 * `bridge_delivery` rows and no error (verified live in swe-brain on 0.20.1 —
 * slot `@schedule/reconcile_due/...` processed 3ms after materialisation, no
 * deliveries; the in-loop tick at the next slot delivered correctly).
 *
 * `onApplicationBootstrap` fires AFTER all modules' `onModuleInit` complete and
 * every hook is attached — the boot tick is then drained against the fully
 * wired pipeline. The tick interval starts here too (it lives inside `start()`,
 * and keeping both passes on the same hook keeps the boot/interval contract in
 * one place).
 */
@Injectable()
export class EventSchedulerLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EventSchedulerLifecycle.name);
  private scheduler: EventScheduler | null = null;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Optional()
    @Inject(EVENTS_MODULE_OPTIONS)
    private readonly opts: EventsModuleOptions | null = null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const registry = this.opts?.eventRegistry;
    if (!registry) return;
    if (typeof this.bus.materializeScheduledEvent !== 'function') return;
    const schedules = scheduledEventsFromRegistry(registry);
    if (schedules.length === 0) return;
    this.scheduler = new EventScheduler(this.bus, schedules);
    await this.scheduler.start();
    this.logger.log(`EventScheduler wired for ${schedules.length} scheduled event(s).`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
  }
}

export interface EventsModuleAsyncOptions {
  useFactory: (...args: unknown[]) => Promise<EventsModuleOptions> | EventsModuleOptions;
  inject?: unknown[];
  imports?: unknown[];
}

/**
 * Shared provider set: `TypedEventBus` itself, the `TYPED_EVENT_BUS` token
 * binding, and the resolved `EVENTS_MULTI_TENANT` flag. Returned from one
 * place so every `forRoot` branch and `forRootAsync` agree.
 */
function buildTypedBusProviders(
  multiTenant: boolean,
  typedBus?: Type<unknown>,
): Provider[] {
  // Package mode threads the consumer's generated `TypedEventBus` (typed to
  // their event union, reading their registry) via `typedBus`; vendored mode
  // omits it and we fall back to the bundled `./generated/bus` (which IS the
  // consumer's generated file in a vendored tree). See `EventsModuleOptions.typedBus`.
  const BusClass = typedBus ?? TypedEventBus;
  return [
    BusClass,
    { provide: TYPED_EVENT_BUS, useExisting: BusClass },
    { provide: EVENTS_MULTI_TENANT, useValue: multiTenant },
  ];
}

/**
 * Construct the backend instance for the async path, routing constructor
 * arguments through Nest-resolved dependencies.
 *
 * DRIZZLE is declared optional at inject time so that memory-backend
 * consumers aren't required to also import `DatabaseModule`. If the
 * drizzle backend is selected but no DRIZZLE provider is registered, we
 * throw a clear error instead of silently constructing a broken bus.
 */
async function buildEventBusAsync(
  options: EventsModuleOptions,
  db: DrizzleClient | null,
  connection: EventsBullMqConnection,
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
  if (options.backend === 'bullmq') {
    // #6: lazy import — the bullmq backend ships only with `--backend bullmq`
    // installs; drizzle/memory consumers never touch the file. It extends
    // DrizzleEventBus (Postgres outbox = source of truth), so it requires
    // DRIZZLE just like the drizzle backend.
    if (!db) {
      throw new Error(
        "EventsModule.forRootAsync: backend: 'bullmq' selected but DRIZZLE provider is not available. " +
          'The BullMQ events backend dispatches over the Postgres outbox (ADR-041); ' +
          'import DatabaseModule (or another provider exposing DRIZZLE) before EventsModule.forRootAsync.',
      );
    }
    const BullMQEventBus = await loadBullMqEventBus();
    return new BullMQEventBus(db, connection, options, bridgeHook);
  }
  return new MemoryEventBus(options);
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
            connection: EventsBullMqConnection,
            bridgeHook: unknown,
          ) => buildEventBusAsync(options, db, connection, bridgeHook),
          inject: [
            EVENTS_MODULE_OPTIONS,
            { token: DRIZZLE, optional: true },
            EVENTS_BULLMQ_CONNECTION,
            { token: BRIDGE_OUTBOX_DRAIN_HOOK, optional: true },
          ],
        },
        {
          // Read port (OBS-LIST-1). All three backends implement
          // IEventReadPort on the EVENT_BUS instance (bullmq inherits it from
          // DrizzleEventBus), so EVENT_READ_PORT is the same instance.
          provide: EVENT_READ_PORT,
          useExisting: EVENT_BUS,
        },
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

    if (options.backend === 'bullmq') {
      const connection = resolveEventsBullMqConnection(options);

      return {
        module: EventsModule,
        global: true,
        providers: [
          { provide: EVENTS_MODULE_OPTIONS, useValue: options },
          { provide: EVENTS_BULLMQ_CONNECTION, useValue: connection },
          {
            // #6: useFactory + dynamic import so the consumer's tsc never needs
            // to resolve `event-bus.bullmq-backend.ts` for drizzle/memory
            // installs (filtered out by `backendFileFilter`). Nest awaits async
            // factories + manages lifecycle (onModuleInit/onModuleDestroy) on
            // the returned instance. The BullMQ events backend extends
            // DrizzleEventBus (Postgres outbox = source of truth, ADR-041), so
            // it injects DRIZZLE + the bridge hook just like the drizzle path.
            provide: EVENT_BUS,
            useFactory: async (
              db: DrizzleClient | null,
              conn: EventsBullMqConnection,
              bridgeHook: unknown,
            ): Promise<object> => {
              if (!db) {
                throw new Error(
                  "EventsModule.forRoot: backend: 'bullmq' selected but DRIZZLE provider is not available. " +
                    'The BullMQ events backend dispatches over the Postgres outbox (ADR-041); ' +
                    'import DatabaseModule (or another provider exposing DRIZZLE) before EventsModule.',
                );
              }
              const BullMQEventBus = await loadBullMqEventBus();
              return new BullMQEventBus(db, conn, options, bridgeHook);
            },
            inject: [
              { token: DRIZZLE, optional: true },
              EVENTS_BULLMQ_CONNECTION,
              { token: BRIDGE_OUTBOX_DRAIN_HOOK, optional: true },
            ],
          },
          // The bullmq backend retains the Postgres outbox, so it DOES provide
          // a read port (inherited from DrizzleEventBus) — unlike the deleted
          // redis pub/sub backend.
          { provide: EVENT_READ_PORT, useExisting: EVENT_BUS },
          // ADR-041: scheduling under backend:'bullmq' is owned by the BullMQ
          // Job Scheduler (SCHED-1 — `BullMqEventSchedulerLifecycle`), NOT the
          // polling `EventSchedulerLifecycle`. Exactly one scheduler source of
          // truth per backend. (Wired in SCHED-1.)
          ...buildTypedBusProviders(multiTenant, options.typedBus),
        ],
        exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
      };
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
        // Read port (OBS-LIST-1): drizzle + memory backends implement
        // IEventReadPort on the same instance as EVENT_BUS.
        { provide: EVENT_READ_PORT, useExisting: EVENT_BUS },
        // ADR-039 — the polling scheduler lifecycle. No-op unless
        // `eventRegistry` was threaded AND some event declared `schedule:`.
        // Drizzle/memory only (the bullmq branch above uses the BullMQ Job
        // Scheduler instead — ADR-041).
        EventSchedulerLifecycle,
        ...buildTypedBusProviders(multiTenant, options.typedBus),
      ],
      exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
    };
  }
}
