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
 * `global: true` means entity modules do not need to import EventsModule
 * individually — the EVENT_BUS token is available project-wide.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { EVENT_BUS, REDIS_URL } from './events.tokens';
import { DrizzleEventBus } from './event-bus.drizzle-backend';
import { MemoryEventBus } from './event-bus.memory-backend';
import { RedisEventBus } from './event-bus.redis-backend';

export interface EventsModuleOptions {
  backend: 'drizzle' | 'memory' | 'redis';
  /**
   * Redis connection URL used when `backend` is `'redis'`.
   * Falls back to the REDIS_URL environment variable, then
   * `redis://localhost:6379` if neither is set.
   */
  redisUrl?: string;
}

export interface EventsModuleAsyncOptions {
  useFactory: (...args: unknown[]) => Promise<EventsModuleOptions> | EventsModuleOptions;
  inject?: unknown[];
  imports?: unknown[];
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
          provide: 'EVENTS_MODULE_OPTIONS',
          useFactory: asyncOptions.useFactory,
          inject: (asyncOptions.inject ?? []) as (string | symbol | Function)[],
        },
        {
          provide: EVENT_BUS,
          useFactory: (options: EventsModuleOptions) => {
            const mod = EventsModule.forRoot(options);
            // Return the provider instance by delegating to forRoot's logic
            const provider = mod.providers?.find(
              (p) => typeof p === 'object' && p !== null && 'provide' in p && p.provide === EVENT_BUS,
            );
            if (provider && typeof provider === 'object' && 'useClass' in provider) {
              return new (provider.useClass as new () => unknown)();
            }
            throw new Error('EventsModule.forRootAsync: failed to resolve provider');
          },
          inject: ['EVENTS_MODULE_OPTIONS'],
        },
      ],
      exports: [EVENT_BUS],
    };
  }

  static forRoot(
    options: EventsModuleOptions = { backend: 'drizzle' },
  ): DynamicModule {
    if (options.backend === 'redis') {
      const resolvedUrl =
        options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';

      return {
        module: EventsModule,
        global: true,
        providers: [
          { provide: REDIS_URL, useValue: resolvedUrl },
          { provide: EVENT_BUS, useClass: RedisEventBus },
          // Register concrete class so NestJS can resolve lifecycle hooks
          RedisEventBus,
        ],
        exports: [EVENT_BUS],
      };
    }

    const provider =
      options.backend === 'drizzle'
        ? { provide: EVENT_BUS, useClass: DrizzleEventBus }
        : { provide: EVENT_BUS, useClass: MemoryEventBus };

    return {
      module: EventsModule,
      global: true,
      providers: [provider],
      exports: [EVENT_BUS],
    };
  }
}
