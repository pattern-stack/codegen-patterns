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
 * then receives its backend dependencies — DRIZZLE for the drizzle
 * backend, REDIS_URL for the redis backend, the resolved options for the
 * memory backend — through a proper `useFactory` so Nest DI wires them
 * correctly. Earlier revisions hand-constructed backends with
 * `new Class()` which silently left `db` / `redisUrl` undefined
 * (issue #108).
 */
import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import {
  EVENT_BUS,
  EVENT_READ_PORT,
  EVENTS_MODULE_OPTIONS,
  EVENTS_MULTI_TENANT,
  REDIS_URL,
  TYPED_EVENT_BUS,
} from './events.tokens';
import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
import { DrizzleEventBus } from './event-bus.drizzle-backend';
import { MemoryEventBus } from './event-bus.memory-backend';
// #6 — `RedisEventBus` is lazy-loaded only when `backend: 'redis'` is selected.
// The file is filtered out of the vendor set for non-redis installs (see
// `backendFileFilter` in src/cli/commands/subsystem.ts); the dynamic-string
// import below makes TS treat the specifier as `any` so the consumer's tsc
// never tries to resolve the absent file.
import { TypedEventBus } from './generated/bus';

/**
 * Lazy-load the Redis backend. Routed through a non-literal specifier so
 * the consumer's `tsc` doesn't resolve `./event-bus.redis-backend` at type
 * check time — important because that file is filtered out of drizzle/
 * memory installs (#6).
 */
async function loadRedisEventBus(): Promise<new (url: string) => object> {
  // Non-literal specifier — TS gives this an `any` module type, sidestepping
  // resolution of a file that may not be vendored.
  const specifier = './event-bus.redis-backend';
  const mod = (await import(specifier)) as { RedisEventBus: new (url: string) => object };
  return mod.RedisEventBus;
}

export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  /**
   * Redis connection URL used when `backend` is `'redis'`.
   * Falls back to the REDIS_URL environment variable, then
   * `redis://localhost:6379` if neither is set.
   */
  redisUrl?: string;
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
  redisUrl: string,
): Promise<unknown> {
  if (options.backend === 'drizzle') {
    if (!db) {
      throw new Error(
        "EventsModule.forRootAsync: backend: 'drizzle' selected but DRIZZLE provider is not available. " +
          'Ensure DatabaseModule (or another provider exposing DRIZZLE) is imported before EventsModule.forRootAsync.',
      );
    }
    return new DrizzleEventBus(db, options);
  }
  if (options.backend === 'redis') {
    // #6: lazy import — the redis backend ships only with `--backend redis`
    // installs; drizzle/memory consumers never touch the file.
    const RedisEventBus = await loadRedisEventBus();
    return new RedisEventBus(redisUrl);
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
          provide: REDIS_URL,
          useFactory: (options: EventsModuleOptions) =>
            options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
          inject: [EVENTS_MODULE_OPTIONS],
        },
        {
          provide: EVENT_BUS,
          useFactory: (
            options: EventsModuleOptions,
            db: DrizzleClient | null,
            redisUrl: string,
          ) => buildEventBusAsync(options, db, redisUrl),
          inject: [
            EVENTS_MODULE_OPTIONS,
            { token: DRIZZLE, optional: true },
            REDIS_URL,
          ],
        },
        {
          // Read port (OBS-LIST-1). Drizzle + memory backends implement
          // IEventReadPort on the EVENT_BUS instance; the redis backend
          // retains no history, so EVENT_READ_PORT resolves to `null` and
          // optional consumers (the observability combiner) degrade to
          // empty results.
          provide: EVENT_READ_PORT,
          useFactory: (options: EventsModuleOptions, bus: unknown) =>
            options.backend === 'redis' ? null : bus,
          inject: [EVENTS_MODULE_OPTIONS, EVENT_BUS],
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

    if (options.backend === 'redis') {
      const resolvedUrl =
        options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';

      return {
        module: EventsModule,
        global: true,
        providers: [
          { provide: EVENTS_MODULE_OPTIONS, useValue: options },
          { provide: REDIS_URL, useValue: resolvedUrl },
          {
            // #6: useFactory + dynamic import so the consumer's tsc never
            // needs to resolve `event-bus.redis-backend.ts` for drizzle/
            // memory installs (the file is filtered out by
            // `backendFileFilter`). Nest awaits async factories + manages
            // lifecycle on the returned instance, so we drop the old bare
            // `RedisEventBus` provider entry.
            provide: EVENT_BUS,
            useFactory: async (url: string): Promise<object> => {
              const RedisEventBus = await loadRedisEventBus();
              return new RedisEventBus(url);
            },
            inject: [REDIS_URL],
          },
          ...buildTypedBusProviders(multiTenant, options.typedBus),
        ],
        exports: [EVENT_BUS, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
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
        // IEventReadPort on the same instance as EVENT_BUS. The redis
        // backend retains no history and does not provide this token.
        { provide: EVENT_READ_PORT, useExisting: EVENT_BUS },
        ...buildTypedBusProviders(multiTenant, options.typedBus),
      ],
      exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
    };
  }
}
