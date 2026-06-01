/**
 * Injection token for the cache service.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(CACHE) private readonly cache: ICacheService) {}
 * ```
 *
 * Services may also inject CACHE for reads (get, has) per ADR-003.
 *
 * ADR-037: namespaced `Symbol.for(...)` key so the token matches by value across
 * import boundaries (package vs vendored runtime copy).
 * TODO(token-version): revisit embedding a contract version once codegen/surface
 * versioning is settled.
 */
export const CACHE = Symbol.for('@pattern-stack/codegen.cache.cache');

/**
 * Injection token for the default TTL (in seconds) passed from CacheModule.forRoot().
 * Optional — omit for no-expiry behavior.
 */
export const CACHE_DEFAULT_TTL = Symbol.for('@pattern-stack/codegen.cache.default-ttl');
