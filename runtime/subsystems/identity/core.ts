/**
 * Identity subsystem: the Nest-free entry (ID-1). Workspaces and membership, the requester resolver and its cache, and
 * the registries the generated `requester` system picks its rows from. A pattern-stack app imports through this file
 * (`subsystemCoreImport(mode, 'identity')`); `src/__tests__/runtime/nest-free.test.ts` holds it Nest-free.
 */
export * from './names';
export * from './workspace-sources';
export * from './requester-cache';
export { MemoryRequesterCache } from './requester-cache.memory-backend';
export { PostgresRequesterCache, IDENTITY_REQUESTER_CHANNEL, type CacheListener, type PostgresRequesterCacheOptions } from './requester-cache.postgres-backend';
export { REQUESTER_CACHES } from './requester-caches';
export * from './requester-resolver';
export * from './workspace-service';
export * from './workspace-commands';
export type { PrincipalSource, RequestFacts, RequesterOutcome, RequesterPort, RequesterRefusal } from '../../requester';
export { requestFacts } from '../../requester';
