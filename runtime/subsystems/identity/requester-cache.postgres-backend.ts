/**
 * The `postgres` requester cache (ID-1): each process caches memberships, and a change reaches every process through
 * Postgres `NOTIFY`.
 *
 * - `invalidate` sends `pg_notify('identity_requester', <key>)` on the change's own transaction, so it is delivered
 *   only when the change commits; the workspace operations then `evict` the key here, so this process needn't wait
 *   for its own notification.
 * - Every process listens on that channel and evicts the key. A fill that read the database before an eviction and
 *   returns after it doesn't store the old role (`CacheEntries`).
 * - While the listener is down it can't hear evictions, so the cache reads through and stores nothing. Each time the
 *   listener connects (the first time, and every reconnect) it clears everything and caches again: what changed while
 *   it was down is gone with the rest.
 *
 * Two backstops for a notification that never comes: the listener's heartbeat makes a quietly dead connection a drop,
 * and no entry is served longer than `REQUESTER_CACHE_MAX_AGE_MS`.
 *
 * The listener needs a direct or session-mode connection: behind a transaction-mode pooler `LISTEN` isn't delivered,
 * and the cache would never start caching (it stays correct, and reads through on every request).
 */
import { PgNotifyListener, listenerPoolOf, pgNotify } from '../events/pg-notify';
import { REQUESTER_CACHE_MAX_AGE_MS, REQUESTER_LISTENER_HEARTBEAT } from './names';
import type { DrizzleClient } from '../../types/drizzle';
import type { DrizzleTransaction } from '../events/event-bus.protocol';
import { CacheEntries, cacheKey, type MembershipKey, type RequesterCache, type RequesterCacheDeps } from './requester-cache';

export const IDENTITY_REQUESTER_CHANNEL = 'identity_requester';

/** The listener's surface the cache uses: `PgNotifyListener`'s, so tests can pass a fake. */
export interface CacheListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface PostgresRequesterCacheOptions {
  /** Build the listener from the cache's callbacks. Defaults to a `PgNotifyListener` on the client's pool. */
  listener?: (hooks: { onNotify: (payload: string) => void; onConnect: () => void; onDrop: () => void }) => CacheListener;
}

export class PostgresRequesterCache implements RequesterCache {
  private readonly entries: CacheEntries;
  private listening = false;
  private readonly listener: CacheListener;

  constructor(
    private readonly deps: RequesterCacheDeps,
    options: PostgresRequesterCacheOptions = {},
  ) {
    this.entries = new CacheEntries(deps.maxAgeMs ?? REQUESTER_CACHE_MAX_AGE_MS, deps.now);
    const hooks = {
      onNotify: (payload: string) => this.entries.evict(payload.toLowerCase()),
      onConnect: () => {
        this.entries.clear();
        this.listening = true;
      },
      onDrop: () => {
        this.listening = false;
        this.entries.clear();
      },
    };
    this.listener = (options.listener ?? ((h) => defaultListener(deps.db, h)))(hooks);
  }

  async role(key: MembershipKey): Promise<string | null> {
    const k = cacheKey(key);
    if (this.listening && this.entries.has(k)) return this.entries.get(k);
    return this.entries.fill(k, () => this.deps.lookup(key), () => this.listening);
  }

  async invalidate(key: MembershipKey, tx: DrizzleClient | DrizzleTransaction): Promise<void> {
    await pgNotify(tx, IDENTITY_REQUESTER_CHANNEL, cacheKey(key));
  }

  evict(key: MembershipKey): void {
    this.entries.evict(cacheKey(key));
  }

  async start(): Promise<void> {
    await this.listener.start();
  }

  async stop(): Promise<void> {
    await this.listener.stop();
    this.listening = false;
    this.entries.clear();
  }

  /** How many memberships are cached (tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Whether the listener is up, so the cache stores what it reads. */
  get caching(): boolean {
    return this.listening;
  }
}

function defaultListener(
  db: DrizzleClient,
  hooks: { onNotify: (payload: string) => void; onConnect: () => void; onDrop: () => void },
): CacheListener {
  // No pool to listen on: never cache (correct, just a read per request).
  const pool = listenerPoolOf(db, 'identity', 'the requester cache reads through on every request');
  if (!pool) return { start: async () => {}, stop: async () => {} };
  return new PgNotifyListener({
    channel: IDENTITY_REQUESTER_CHANNEL,
    pool,
    label: 'identity',
    // A half-open socket emits no error: the heartbeat turns it into a drop, so the cache stops serving.
    heartbeatMs: REQUESTER_LISTENER_HEARTBEAT.everyMs,
    heartbeatTimeoutMs: REQUESTER_LISTENER_HEARTBEAT.timeoutMs,
    ...hooks,
  });
}
