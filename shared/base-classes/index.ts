/**
 * Base classes barrel export
 */
export { BaseRepository } from './base-repository';
export type { BehaviorConfig, ListOptions } from './base-repository';

export { BaseService } from './base-service';
export type { IBaseRepository } from './base-service';

export { BaseFindByIdUseCase, BaseListUseCase } from './base-read-use-cases';
export type { IFindByIdService, IListService } from './base-read-use-cases';

// Family-specific repository base classes
export { CrmEntityRepository } from './crm-entity-repository';
export { ActivityEntityRepository } from './activity-entity-repository';
export { MetadataEntityRepository } from './metadata-entity-repository';
export { KnowledgeEntityRepository } from './knowledge-entity-repository';
