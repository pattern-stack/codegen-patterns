/**
 * CacheModule — DynamicModule factory for the cache subsystem.
 *
 * Usage in AppModule:
 * ```typescript
 * CacheModule.forRoot({ backend: 'drizzle', defaultTtl: 300 })
 * ```
 *
 * Usage in tests:
 * ```typescript
 * CacheModule.forRoot({ backend: 'memory' })
 * ```
 *
 * `global: true` means any module that needs ICacheService can inject CACHE
 * directly without importing CacheModule. Register once in AppModule.
 *
 * The drizzle backend requires DRIZZLE to be provided globally (e.g., via DatabaseModule).
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CACHE, CACHE_DEFAULT_TTL } from './cache.tokens';
import { DrizzleCacheService } from './cache.drizzle-backend';
import { MemoryCacheService } from './cache.memory-backend';

export interface CacheModuleOptions {
  backend: 'drizzle' | 'memory';
  /** Default TTL in seconds for entries that don't specify their own TTL. Null = no expiry. */
  defaultTtl?: number;
}

export interface CacheModuleAsyncOptions {
  useFactory: (...args: unknown[]) => Promise<CacheModuleOptions> | CacheModuleOptions;
  inject?: unknown[];
  imports?: unknown[];
}

@Module({})
export class CacheModule {
  static forRootAsync(asyncOptions: CacheModuleAsyncOptions): DynamicModule {
    return {
      module: CacheModule,
      global: true,
      imports: (asyncOptions.imports ?? []) as Parameters<typeof Module>[0]['imports'],
      providers: [
        {
          provide: 'CACHE_MODULE_OPTIONS',
          useFactory: asyncOptions.useFactory,
          inject: (asyncOptions.inject ?? []) as (string | symbol | Function)[],
        },
        {
          provide: CACHE,
          useFactory: (options: CacheModuleOptions) => {
            if (options.backend === 'drizzle') {
              return new DrizzleCacheService(
                null as unknown as Parameters<typeof DrizzleCacheService.prototype.get>[0] extends never ? never : Parameters<typeof DrizzleCacheService['prototype']['get']>[0] extends never ? never : never,
                options.defaultTtl ?? null,
              );
            }
            return new MemoryCacheService(options.defaultTtl ?? null);
          },
          inject: ['CACHE_MODULE_OPTIONS'],
        },
        { provide: DrizzleCacheService, useExisting: CACHE },
        { provide: MemoryCacheService, useExisting: CACHE },
      ],
      exports: [CACHE],
    };
  }

  static forRoot(options: CacheModuleOptions = { backend: 'drizzle' }): DynamicModule {
    const ConcreteClass = options.backend === 'drizzle' ? DrizzleCacheService : MemoryCacheService;

    const providers = options.defaultTtl !== undefined
      ? [
          // Register the concrete class as the canonical instance
          ConcreteClass,
          { provide: CACHE_DEFAULT_TTL, useValue: options.defaultTtl },
          // CACHE token points to the same instance — no duplicate
          { provide: CACHE, useExisting: ConcreteClass },
        ]
      : [
          ConcreteClass,
          { provide: CACHE, useExisting: ConcreteClass },
        ];

    return {
      module: CacheModule,
      global: true,
      providers,
      exports: [CACHE],
    };
  }
}
