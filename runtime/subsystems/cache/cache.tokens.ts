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
 * ADR-037: namespaced `Symbol.for(...)` key (via `tokenKey()`) so the token matches
 * by value across import boundaries (package vs vendored runtime copy).
 */
import { tokenKey } from '../token-key';

export const CACHE = Symbol.for(tokenKey('cache', 'cache'));

/**
 * Injection token for the default TTL (in seconds) passed from CacheModule.forRoot().
 * Optional — omit for no-expiry behavior.
 */
export const CACHE_DEFAULT_TTL = Symbol.for(tokenKey('cache', 'default-ttl'));
