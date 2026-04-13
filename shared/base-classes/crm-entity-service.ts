/**
 * CrmEntityService<TRepo, TEntity>
 *
 * Family-specific base service for CRM-synced entities.
 * Delegates to a CRM repository that provides external ID lookups
 * and user-scoped queries.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface ICrmEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByExternalId(externalId: string): Promise<TEntity | null>;
  findManyByExternalIds(externalIds: string[]): Promise<TEntity[]>;
  findAllByUserId(userId: string): Promise<TEntity[]>;
}

export abstract class CrmEntityService<
  TRepo extends ICrmEntityRepository<TEntity>,
  TEntity,
> extends BaseService<TRepo, TEntity> {
  /**
   * Find a single entity by its external CRM identifier.
   */
  findByExternalId(externalId: string): Promise<TEntity | null> {
    return this.repository.findByExternalId(externalId);
  }

  /**
   * Find all entities owned by a specific user.
   */
  findAllByUser(userId: string): Promise<TEntity[]> {
    return this.repository.findAllByUserId(userId);
  }
}
