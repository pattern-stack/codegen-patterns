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
import { CACHE } from './cache.tokens';
import { CACHE_DEFAULT_TTL, DrizzleCacheService } from './cache.drizzle-backend';
import { MemoryCacheService } from './cache.memory-backend';

export interface CacheModuleOptions {
  backend: 'drizzle' | 'memory';
  /** Default TTL in seconds for entries that don't specify their own TTL. Null = no expiry. */
  defaultTtl?: number;
}

@Module({})
export class CacheModule {
  static forRoot(options: CacheModuleOptions = { backend: 'drizzle' }): DynamicModule {
    const cacheProvider =
      options.backend === 'drizzle'
        ? { provide: CACHE, useClass: DrizzleCacheService }
        : { provide: CACHE, useClass: MemoryCacheService };

    const providers = options.defaultTtl !== undefined
      ? [
          cacheProvider,
          { provide: CACHE_DEFAULT_TTL, useValue: options.defaultTtl },
          // Register concrete class so NestJS can resolve lifecycle hooks
          options.backend === 'drizzle' ? DrizzleCacheService : MemoryCacheService,
        ]
      : [
          cacheProvider,
          // Register concrete class so NestJS can resolve lifecycle hooks
          options.backend === 'drizzle' ? DrizzleCacheService : MemoryCacheService,
        ];

    return {
      module: CacheModule,
      global: true,
      providers,
      exports: [CACHE],
    };
  }
}
