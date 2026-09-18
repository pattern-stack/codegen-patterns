/**
 * Base classes barrel export
 */
export { BaseRepository, column, tenantPredicateFor } from './base-repository';
export type { BehaviorConfig, ListOptions, RowsOf } from './base-repository';

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
  // Tenant axis (ADR-042 / TEN-1)
  getTenantId,
  withTenantScope,
  withAllTenants,
  MissingTenantIdError,
  CrossTenantWriteError,
  SYSTEM_ACTOR_ID,
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

// Integration upsert config (consumed by IntegratedEntityRepository + JunctionIntegrationRepository)
export type { IntegrationUpsertConfig, IntegrationFkResolver } from './integration-upsert-config';

// Family-specific repository base classes
export { IntegratedEntityRepository } from './integrated-entity-repository';
export {
  JunctionIntegrationRepository,
  buildCompositeExternalId,
  parseCompositeExternalId,
} from './junction-integration-repository';
export type { JunctionIntegrationConfig } from './junction-integration-repository';
export { ActivityEntityRepository } from './activity-entity-repository';
export { MetadataEntityRepository } from './metadata-entity-repository';
export { KnowledgeEntityRepository } from './knowledge-entity-repository';

// Family-specific service base classes
export { IntegratedEntityService } from './integrated-entity-service';
export type { IIntegratedEntityRepository } from './integrated-entity-service';
export { ActivityEntityService } from './activity-entity-service';
export type { IActivityEntityRepository } from './activity-entity-service';
export { MetadataEntityService } from './metadata-entity-service';
export type { IMetadataEntityRepository } from './metadata-entity-service';
export { KnowledgeEntityService } from './knowledge-entity-service';

// Mixins
export { WithAnalytics } from './with-analytics';

// Library capability mixins (ADR-041.1) — layered by the `Actor` /
// `Communication` capability patterns.
export { WithActor } from './with-actor';
export type { ActorConfig, IndividualActorConfig, GroupActorConfig } from './with-actor';
export { WithCommunication } from './with-communication';
export type {
	CommunicationConfig,
	RoleEdge,
	OneRoleEdge,
	ManyRoleEdge,
	Participant,
} from './with-communication';

// Capability mixin contract (ADR-041) — the types a `kind: 'capability'`
// pattern's repository mixin is written against.
export type {
	RepositoryCtor,
	RepositoryOf,
	EntityOf,
	TableOf,
} from './capability-mixin';
