/**
 * Base classes barrel export
 */
export { BaseRepository } from './base-repository';
export type { BehaviorConfig, ListOptions } from './base-repository';

// Ambient tenant scope (AsyncLocalStorage) — read by BaseRepository.scopePredicate,
// set at request/worker boundaries via withRequester/withUserScope/etc.
export {
  withRequester,
  requireRequester,
  tryGetRequester,
  requireRequesterScope,
  withUserScope,
  withOrgScope,
  withSuperuserScope,
} from './tenant-context';
export type { RequesterContext, RequesterScope } from './tenant-context';

export { BaseService } from './base-service';
export type { IBaseRepository } from './base-service';

export {
  entitySnapshot,
  diffSnapshots,
  buildLifecycleEvent,
  buildChangeEvents,
  emitSafely,
} from './lifecycle-events';
export type { EventCategory } from './lifecycle-events';

export { BaseFindByIdUseCase, BaseListUseCase } from './base-read-use-cases';
export type { IFindByIdService, IListService } from './base-read-use-cases';

// Sync upsert config (consumed by SyncedEntityRepository + JunctionSyncRepository)
export type { SyncUpsertConfig, SyncFkResolver } from './sync-upsert-config';

// Family-specific repository base classes
export { SyncedEntityRepository } from './synced-entity-repository';
export {
  JunctionSyncRepository,
  buildCompositeExternalId,
  parseCompositeExternalId,
} from './junction-sync-repository';
export type { JunctionSyncConfig } from './junction-sync-repository';
export { ActivityEntityRepository } from './activity-entity-repository';
export { MetadataEntityRepository } from './metadata-entity-repository';
export { KnowledgeEntityRepository } from './knowledge-entity-repository';

// Family-specific service base classes
export { SyncedEntityService } from './synced-entity-service';
export type { ISyncedEntityRepository } from './synced-entity-service';
export { ActivityEntityService } from './activity-entity-service';
export type { IActivityEntityRepository } from './activity-entity-service';
export { MetadataEntityService } from './metadata-entity-service';
export type { IMetadataEntityRepository } from './metadata-entity-service';
export { KnowledgeEntityService } from './knowledge-entity-service';

// Mixins
export { WithAnalytics } from './with-analytics';
