/**
 * ActivityEntityService<TRepo, TEntity>
 *
 * Family-specific base service for activity entities.
 * Delegates to an activity repository that provides date-range,
 * user, and opportunity queries.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface IActivityEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByDateRange(start: Date, end: Date): Promise<TEntity[]>;
  findByUserId(userId: string): Promise<TEntity[]>;
  findByOpportunityId(opportunityId: string): Promise<TEntity[]>;
  findRecentByOpportunityId(opportunityId: string, limit?: number): Promise<TEntity[]>;
}

export abstract class ActivityEntityService<
  TRepo extends IActivityEntityRepository<TEntity>,
  TEntity,
> extends BaseService<TRepo, TEntity> {
  /**
   * Find activities within a date range (inclusive).
   */
  findByDateRange(start: Date, end: Date): Promise<TEntity[]> {
    return this.repository.findByDateRange(start, end);
  }

  /**
   * Find all activities for a specific user.
   */
  findByUser(userId: string): Promise<TEntity[]> {
    return this.repository.findByUserId(userId);
  }

  /**
   * Find all activities for a specific opportunity.
   */
  findByOpportunity(opportunityId: string): Promise<TEntity[]> {
    return this.repository.findByOpportunityId(opportunityId);
  }

  /**
   * Find the most recent activities for an opportunity.
   */
  findRecent(opportunityId: string, limit?: number): Promise<TEntity[]> {
    return this.repository.findRecentByOpportunityId(opportunityId, limit);
  }
}
