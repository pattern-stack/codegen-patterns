/**
 * IntegratedEntityService<TRepo, TEntity>
 *
 * Family-specific base service for Integrated entities.
 * Delegates to a CRM repository that provides external ID lookups.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface IIntegratedEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByExternalId(externalId: string): Promise<TEntity | null>;
  findManyByExternalIds(externalIds: string[]): Promise<TEntity[]>;
  integrationUpsert(inputs: Array<Partial<TEntity>>): Promise<TEntity[]>;
}

export abstract class IntegratedEntityService<
  TRepo extends IIntegratedEntityRepository<TEntity>,
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
}
