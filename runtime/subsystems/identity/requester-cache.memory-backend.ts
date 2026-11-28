/**
 * The `memory` requester cache (ID-1): one process's map. The workspace operations evict a key after the change
 * commits, and a fill that read the old row meanwhile doesn't store it. For tests and a single process; with more than
 * one, use `postgres`, which tells every process.
 */
import { REQUESTER_CACHE_MAX_AGE_MS } from './names';
import { CacheEntries, cacheKey, type MembershipKey, type RequesterCache, type RequesterCacheDeps } from './requester-cache';

export class MemoryRequesterCache implements RequesterCache {
  private readonly entries: CacheEntries;

  constructor(private readonly deps: Pick<RequesterCacheDeps, 'lookup' | 'maxAgeMs' | 'now'>) {
    this.entries = new CacheEntries(deps.maxAgeMs ?? REQUESTER_CACHE_MAX_AGE_MS, deps.now);
  }

  async role(key: MembershipKey): Promise<string | null> {
    const k = cacheKey(key);
    if (this.entries.has(k)) return this.entries.get(k);
    return this.entries.fill(k, () => this.deps.lookup(key), () => true);
  }

  /** Nobody else to tell: the eviction is `evict`, after the commit. */
  async invalidate(): Promise<void> {}

  evict(key: MembershipKey): void {
    this.entries.evict(cacheKey(key));
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
