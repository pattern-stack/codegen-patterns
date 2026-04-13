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
}
