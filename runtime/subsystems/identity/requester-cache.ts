/**
 * The requester cache (ID-1): a principal's role in a workspace, or "not a member", remembered between requests and
 * evicted when a membership changes. The core contract every backend keeps; `REQUESTER_CACHES` has the rows.
 */
import type { DrizzleClient } from '../../types/drizzle';
import type { DrizzleTransaction } from '../events/event-bus.protocol';

export interface MembershipKey {
  readonly principalId: string;
  readonly workspaceId: string;
}

/** Reads a membership's role from the database; null when the principal isn't a member. */
export type MembershipLookup = (key: MembershipKey) => Promise<string | null>;

export interface RequesterCache {
  /** The principal's role in the workspace, or null (not a member). */
  role(key: MembershipKey): Promise<string | null>;
  /**
   * In the transaction that changes the membership: tell whoever else caches it (the `postgres` backend sends a
   * notification, delivered only when the change commits).
   */
  invalidate(key: MembershipKey, tx: DrizzleClient | DrizzleTransaction): Promise<void>;
  /** After that transaction commits: forget it here. A fill that read the old row before this doesn't store it. */
  evict(key: MembershipKey): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** What every cache backend is built from. */
export interface RequesterCacheDeps {
  db: DrizzleClient;
  lookup: MembershipLookup;
  /** The longest an entry is served (default `REQUESTER_CACHE_MAX_AGE_MS`). */
  maxAgeMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** One key per membership. Ids are compared lowercased, as Postgres compares uuids. */
export const cacheKey = (key: MembershipKey): string => `${key.principalId.toLowerCase()}:${key.workspaceId.toLowerCase()}`;

/**
 * The entries both backends keep, and the one rule that makes eviction safe: a fill stores what it read only if
 * nothing evicted its key (or cleared everything) while it was reading. Each fill in flight holds a token that an
 * eviction marks; a key's tokens live only while its fills do, so nothing grows with the keys evicted.
 */
export class CacheEntries {
  private readonly entries = new Map<string, { role: string | null; at: number }>();
  private readonly fills = new Map<string, Set<{ evicted: boolean }>>();

  /** `maxAgeMs`: an entry older than this is read again (the backstop for a notification that never came). */
  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.now() - entry.at < this.maxAgeMs) return true;
    this.entries.delete(key);
    return false;
  }

  get(key: string): string | null {
    return this.entries.get(key)?.role ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read through `load`, and store the result if `store()` still says so and nothing evicted the key meanwhile. */
  async fill(key: string, load: () => Promise<string | null>, store: () => boolean): Promise<string | null> {
    const token = { evicted: false };
    const tokens = this.fills.get(key) ?? new Set<{ evicted: boolean }>();
    this.fills.set(key, tokens);
    tokens.add(token);
    const startedAt = this.now();
    try {
      const role = await load();
      // Aged from when the read began, so a slow read can't extend what it saw.
      if (!token.evicted && store()) this.entries.set(key, { role, at: startedAt });
      return role;
    } finally {
      tokens.delete(token);
      if (tokens.size === 0) this.fills.delete(key);
    }
  }

  evict(key: string): void {
    this.entries.delete(key);
    for (const token of this.fills.get(key) ?? []) token.evicted = true;
  }

  clear(): void {
    this.entries.clear();
    for (const tokens of this.fills.values()) for (const token of tokens) token.evicted = true;
  }
}
