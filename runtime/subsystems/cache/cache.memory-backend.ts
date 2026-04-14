/**
 * MemoryCacheService — Map-backed ICacheService for tests and development.
 *
 * TTL is enforced via setTimeout — expired entries are deleted from the Map
 * when the timer fires. get() / has() also check the expiry time defensively
 * in case the timer fires late.
 *
 * No lifecycle hooks required — all state is in-process.
 *
 * Error behavior:
 * - get() / has() never throw; they return null/false.
 * - set() / delete() / invalidateByPrefix() throw on failure (consistent with protocol).
 */
import { Injectable, Inject, Optional } from '@nestjs/common';
import type { ICacheService } from './cache.protocol';
import { CACHE_DEFAULT_TTL } from './cache.tokens';

interface CacheRecord {
  value: unknown;
  expiresAt: number | null; // epoch ms, or null for no expiry
}

@Injectable()
export class MemoryCacheService implements ICacheService {
  private readonly store = new Map<string, CacheRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight getOrSet promises — keyed by cache key to deduplicate stampedes. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    @Optional() @Inject(CACHE_DEFAULT_TTL) private readonly defaultTtl: number | null = null,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const record = this.store.get(key);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.evict(key);
      return null;
    }
    return record.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const effectiveTtl = ttlSeconds ?? this.defaultTtl ?? null;

    // Clear any existing timer for this key
    this.clearTimer(key);

    const expiresAt = effectiveTtl !== null ? Date.now() + effectiveTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });

    if (effectiveTtl !== null) {
      const timer = setTimeout(() => this.evict(key), effectiveTtl * 1000);
      this.timers.set(key, timer);
    }
  }

  async delete(key: string): Promise<void> {
    this.evict(key);
  }

  async invalidateByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.evict(key);
        count++;
      }
    }
    return count;
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async getOrSet<T = unknown>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    // Fast path: cache hit
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Stampede protection: if another call is already computing this key, reuse its promise
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    const promise = factory().then(async (value) => {
      await this.set(key, value, ttlSeconds);
      return value;
    }).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise as Promise<unknown>);
    return promise;
  }

  /** Remove a key from store and cancel its expiry timer. */
  private evict(key: string): void {
    this.store.delete(key);
    this.clearTimer(key);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
