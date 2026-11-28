/** The requester cache rows (ID-1). Adding a backend is adding a name in `names.ts` and its row here. */
import type { RequesterCacheName } from './names';
import type { RequesterCache, RequesterCacheDeps } from './requester-cache';
import { MemoryRequesterCache } from './requester-cache.memory-backend';
import { PostgresRequesterCache } from './requester-cache.postgres-backend';

export const REQUESTER_CACHES: Readonly<Record<RequesterCacheName, (deps: RequesterCacheDeps) => RequesterCache>> = {
  postgres: (deps) => new PostgresRequesterCache(deps),
  memory: (deps) => new MemoryRequesterCache(deps),
};
