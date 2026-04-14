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

@Module({})
export class EventsModule {
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
