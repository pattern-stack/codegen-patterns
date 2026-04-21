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
 *
 * Async configuration (`forRootAsync`):
 * The async factory returns `CacheModuleOptions`; the CACHE provider then
 * receives DRIZZLE (for the drizzle backend) through Nest DI rather than
 * hand-constructing with `null` — see issue #108 which flagged the same
 * shape in `EventsModule.forRootAsync`. DRIZZLE is injected as optional
 * so memory-backend consumers are not required to wire DatabaseModule.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CACHE, CACHE_DEFAULT_TTL } from './cache.tokens';
import { DRIZZLE } from '../../constants/tokens';
import type { DrizzleClient } from '../../types/drizzle';
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

/** String token for the resolved CacheModuleOptions in the async path. */
const CACHE_MODULE_OPTIONS = 'CACHE_MODULE_OPTIONS' as const;

function buildCacheAsync(
  options: CacheModuleOptions,
  db: DrizzleClient | null,
): DrizzleCacheService | MemoryCacheService {
  const defaultTtl = options.defaultTtl ?? null;
  if (options.backend === 'drizzle') {
    if (!db) {
      throw new Error(
        "CacheModule.forRootAsync: backend: 'drizzle' selected but DRIZZLE provider is not available. " +
          'Ensure DatabaseModule (or another provider exposing DRIZZLE) is imported before CacheModule.forRootAsync.',
      );
    }
    return new DrizzleCacheService(db, defaultTtl);
  }
  return new MemoryCacheService(defaultTtl);
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
          provide: CACHE_MODULE_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: (asyncOptions.inject ?? []) as (string | symbol | Function)[],
        },
        {
          provide: CACHE,
          useFactory: (options: CacheModuleOptions, db: DrizzleClient | null) =>
            buildCacheAsync(options, db),
          inject: [CACHE_MODULE_OPTIONS, { token: DRIZZLE, optional: true }],
        },
        // Alias the concrete classes to CACHE for typed injection.
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
