/**
 * MetadataEntityService<TRepo, TEntity>
 *
 * Family-specific base service for metadata entities.
 * Delegates to a metadata repository that provides entity-scoped
 * lookups, history, and bulk upsert.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface IMetadataEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByEntityIdAndType(entityId: string, entityType: string): Promise<TEntity[]>;
  listByEntityId(entityId: string): Promise<TEntity[]>;
  listHistoryByEntityId(entityId: string): Promise<TEntity[]>;
  upsertMany(inputs: Array<Partial<TEntity>>, tx?: unknown, options?: { conflictTarget?: string }): Promise<TEntity[]>;
}

export abstract class MetadataEntityService<
  TRepo extends IMetadataEntityRepository<TEntity>,
  TEntity,
> extends BaseService<TRepo, TEntity> {
  /**
   * Find metadata records by entity ID and entity type (EAV polymorphic lookup).
   */
  findByEntityIdAndType(entityId: string, entityType: string): Promise<TEntity[]> {
    return this.repository.findByEntityIdAndType(entityId, entityType);
  }

  /**
   * List all metadata records for an entity.
   */
  listByEntity(entityId: string): Promise<TEntity[]> {
    return this.repository.listByEntityId(entityId);
  }

  /**
   * List metadata history for an entity, ordered by validFrom desc.
   */
  listHistory(entityId: string): Promise<TEntity[]> {
    return this.repository.listHistoryByEntityId(entityId);
  }

  /**
   * Bulk upsert metadata values.
   */
  upsertValues(inputs: Array<Partial<TEntity>>, conflictTarget: string, tx?: unknown): Promise<TEntity[]> {
    return this.repository.upsertMany(inputs, tx, { conflictTarget });
  }
}
