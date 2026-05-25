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
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
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
import { RedisEventBus } from './event-bus.redis-backend';
import { TypedEventBus } from './generated/bus';

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
function buildTypedBusProviders(multiTenant: boolean): Provider[] {
  return [
    TypedEventBus,
    { provide: TYPED_EVENT_BUS, useExisting: TypedEventBus },
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
function buildEventBusAsync(
  options: EventsModuleOptions,
  db: DrizzleClient | null,
  redisUrl: string,
): unknown {
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
          { provide: EVENT_BUS, useClass: RedisEventBus },
          // Register concrete class so NestJS can resolve lifecycle hooks
          RedisEventBus,
          ...buildTypedBusProviders(multiTenant),
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
        ...buildTypedBusProviders(multiTenant),
      ],
      exports: [EVENT_BUS, EVENT_READ_PORT, TYPED_EVENT_BUS, EVENTS_MULTI_TENANT],
    };
  }
}
