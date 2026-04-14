/**
 * DrizzleCacheService — Postgres-backed ICacheService via Drizzle ORM.
 *
 * Storage: `cache_entries` table with key (text pk), value (jsonb), expiresAt (timestamp).
 * TTL enforcement: reads filter by `expiresAt > now() OR expiresAt IS NULL`.
 * Prefix invalidation: `DELETE WHERE key LIKE 'escaped_prefix%'`.
 *
 * Lifecycle:
 * - OnModuleInit: starts periodic cleanup of expired entries.
 *   Uses the Jobs subsystem if available (optional injection); falls back to setInterval.
 * - OnModuleDestroy: clears the setInterval timer if used.
 *
 * Error behavior per ADR-008:
 * - get() / has() return null/false on any error (never throw for reads).
 * - set() / delete() / invalidateByPrefix() throw on failure.
 */
import { Injectable, Inject, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { gt, or, like, sql, eq } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import type { ICacheService } from './cache.protocol';
import { cacheEntries } from './cache.schema';
import { DRIZZLE } from '../../constants/tokens';
import { CACHE_DEFAULT_TTL } from './cache.tokens';

// Re-export for backward compatibility
export { CACHE_DEFAULT_TTL } from './cache.tokens';

/** Cleanup interval in milliseconds when jobs subsystem is unavailable. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class DrizzleCacheService implements ICacheService, OnModuleInit, OnModuleDestroy {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight getOrSet promises — keyed by cache key to deduplicate stampedes. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Optional() @Inject(CACHE_DEFAULT_TTL) private readonly defaultTtl: number | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    this.cleanupTimer = setInterval(() => {
      void this.deleteExpired();
    }, CLEANUP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const rows = await this.db
        .select()
        .from(cacheEntries)
        .where(
          sql`${cacheEntries.key} = ${key} AND (${cacheEntries.expiresAt} IS NULL OR ${cacheEntries.expiresAt} > now())`,
        )
        .limit(1);

      if (rows.length === 0) return null;
      return rows[0]!.value as T;
    } catch {
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const effectiveTtl = ttlSeconds ?? this.defaultTtl ?? null;
    const expiresAt =
      effectiveTtl !== null
        ? new Date(Date.now() + effectiveTtl * 1000)
        : null;

    const jsonValue = value as Parameters<typeof cacheEntries.value.mapFromDriverValue>[0];
    await this.db
      .insert(cacheEntries)
      .values({ key, value: jsonValue, expiresAt })
      .onConflictDoUpdate({
        target: cacheEntries.key,
        set: { value: jsonValue, expiresAt },
      });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(cacheEntries).where(eq(cacheEntries.key, key));
  }

  async invalidateByPrefix(prefix: string): Promise<number> {
    // Escape LIKE wildcards to prevent prefix characters from matching unintended entries
    const escaped = prefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const result = await this.db
      .delete(cacheEntries)
      .where(like(cacheEntries.key, `${escaped}%`))
      .returning({ key: cacheEntries.key });
    return result.length;
  }

  async has(key: string): Promise<boolean> {
    try {
      const result = await this.get(key);
      return result !== null;
    } catch {
      return false;
    }
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

  /** Remove all expired entries. Called by the cleanup timer. */
  private async deleteExpired(): Promise<void> {
    try {
      await this.db
        .delete(cacheEntries)
        .where(
          or(
            gt(sql`now()`, cacheEntries.expiresAt),
          ),
        );
    } catch {
      // Cleanup failures are non-fatal — stale rows are filtered at read time
    }
  }
}
