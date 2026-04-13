/**
 * SyncedEntityService<TRepo, TEntity>
 *
 * Family-specific base service for Synced entities.
 * Delegates to a CRM repository that provides external ID lookups
 * and user-scoped queries.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface ISyncedEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByExternalId(externalId: string): Promise<TEntity | null>;
  findManyByExternalIds(externalIds: string[]): Promise<TEntity[]>;
  findAllByUserId(userId: string): Promise<TEntity[]>;
  findVisibleByUserId(userId: string): Promise<TEntity[]>;
  syncUpsert(inputs: Array<Partial<TEntity>>): Promise<TEntity[]>;
}

export abstract class SyncedEntityService<
  TRepo extends ISyncedEntityRepository<TEntity>,
  TEntity,
> extends BaseService<TRepo, TEntity> {
  /**
   * Find a single entity by its external CRM identifier.
   */
  findByExternalId(externalId: string): Promise<TEntity | null> {
    return this.repository.findByExternalId(externalId);
  }

  /**
   * Find multiple entities by external CRM identifiers.
   */
  findManyByExternalIds(externalIds: string[]): Promise<TEntity[]> {
    return this.repository.findManyByExternalIds(externalIds);
  }

  /**
   * Find all entities owned by a specific user.
   */
  findAllByUser(userId: string): Promise<TEntity[]> {
    return this.repository.findAllByUserId(userId);
  }

  /**
   * Find entities visible to a user (ownership + sharing rules).
   * Concrete services may override with domain-specific visibility logic.
   */
  findVisibleByUser(userId: string): Promise<TEntity[]> {
    return this.repository.findVisibleByUserId(userId);
  }
}
