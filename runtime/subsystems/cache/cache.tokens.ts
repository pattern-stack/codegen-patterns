/**
 * Injection token for the cache service.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(CACHE) private readonly cache: ICacheService) {}
 * ```
 *
 * Services may also inject CACHE for reads (get, has) per ADR-003.
 */
export const CACHE = Symbol('CACHE');
