/**
 * ActivityEntityService<TRepo, TEntity>
 *
 * Family-specific base service for activity / interaction entities. Delegates
 * to an activity repository that provides date-range, actor (`user_id`), and
 * config-driven subject queries. The subject FK column is resolved inside the
 * repository from its `patternConfig` (ADR-031 §4) — the service is
 * subject-name-agnostic. See ACTIVITY-SUBJECT-1.
 */
import { BaseService, type IBaseRepository } from './base-service';

export interface IActivityEntityRepository<TEntity> extends IBaseRepository<TEntity> {
  findByDateRange(start: Date, end: Date): Promise<TEntity[]>;
  findByUserId(userId: string): Promise<TEntity[]>;
  findBySubjectId(subjectId: string): Promise<TEntity[]>;
  findRecentBySubjectId(subjectId: string, limit?: number): Promise<TEntity[]>;
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
   * Find all activities for a specific user (actor / owner scoping).
   */
  findByUser(userId: string): Promise<TEntity[]> {
    return this.repository.findByUserId(userId);
  }

  /**
   * Find all activities for a specific subject (config-driven FK column).
   */
  findBySubject(subjectId: string): Promise<TEntity[]> {
    return this.repository.findBySubjectId(subjectId);
  }

  /**
   * Find the most recent activities for a subject.
   */
  findRecent(subjectId: string, limit?: number): Promise<TEntity[]> {
    return this.repository.findRecentBySubjectId(subjectId, limit);
  }
}
