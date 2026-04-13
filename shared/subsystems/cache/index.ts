/**
 * Cache subsystem public API.
 *
 * Import the token and protocol in use cases and services:
 * ```typescript
 * import { CACHE, type ICacheService } from '@shared/subsystems/cache';
 * ```
 *
 * Import the module in AppModule:
 * ```typescript
 * import { CacheModule } from '@shared/subsystems/cache';
 * CacheModule.forRoot({ backend: 'drizzle', defaultTtl: 300 })
 * ```
 */
export { CACHE } from './cache.tokens';
export type { ICacheService } from './cache.protocol';
export { CacheModule } from './cache.module';
export type { CacheModuleOptions } from './cache.module';
export { cacheEntries } from './cache.schema';
export type { CacheEntry } from './cache.schema';
export { DrizzleCacheService, CACHE_DEFAULT_TTL } from './cache.drizzle-backend';
export { MemoryCacheService } from './cache.memory-backend';
