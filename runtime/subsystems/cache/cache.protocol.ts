/**
 * ICacheService — the cache port.
 *
 * Per ADR-003:
 * - Cache reads (get, has) are NOT side effects — services may call them.
 * - Cache writes (set, delete, invalidateByPrefix) ARE side effects — use cases only.
 *
 * Error behavior:
 * - get() returns null on any error (cache miss semantics; never throws for reads).
 * - has() returns false on any error.
 * - set(), delete(), invalidateByPrefix() throw on failure.
 */
export interface ICacheService {
  /** Read a cached value. Returns null on miss or error. */
  get<T = unknown>(key: string): Promise<T | null>;

  /** Write a value to cache with an optional TTL in seconds. */
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Delete a single cache entry by key. */
  delete(key: string): Promise<void>;

  /**
   * Delete all entries whose key starts with the given prefix.
   * Returns the number of entries deleted.
   *
   * Example: invalidateByPrefix('contact:') removes all contact cache entries.
   */
  invalidateByPrefix(prefix: string): Promise<number>;

  /** Check whether a non-expired entry exists for the given key. Returns false on error. */
  has(key: string): Promise<boolean>;

  /**
   * Return the cached value for `key`, or compute it via `factory` and store it.
   *
   * Stampede protection: concurrent calls for the same key that miss the cache
   * will share the same in-flight promise — the factory is invoked only once.
   *
   * @param key - Cache key
   * @param factory - Async function that computes the value on cache miss
   * @param ttlSeconds - Optional TTL; falls back to the module-configured default
   */
  getOrSet<T = unknown>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>;
}
