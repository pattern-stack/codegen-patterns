/**
 * ActivityEntityRepository<TEntity>
 *
 * Family-specific base for activity entities (emails, calls, meetings, notes).
 * Adds date-range queries, user/opportunity scoping, and recency ordering.
 *
 * Concrete repos extend this and declare their table + behaviors.
 */
import { eq, between, desc } from 'drizzle-orm';
import { BaseRepository } from './base-repository';

export abstract class ActivityEntityRepository<TEntity> extends BaseRepository<TEntity> {
  /**
   * Find activities within a date range (inclusive).
   */
  async findByDateRange(start: Date, end: Date): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(between(this.table['occurredAt'], start, end));
    return rows as TEntity[];
  }

  /**
   * Find all activities for a specific user.
   */
  async findByUserId(userId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['userId'], userId));
    return rows as TEntity[];
  }

  /**
   * Find all activities for a specific opportunity.
   */
  async findByOpportunityId(opportunityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['opportunityId'], opportunityId));
    return rows as TEntity[];
  }

  /**
   * Find the most recent activities for an opportunity, ordered by occurredAt desc.
   */
  async findRecentByOpportunityId(opportunityId: string, limit = 10): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['opportunityId'], opportunityId))
      .orderBy(desc(this.table['occurredAt']))
      .limit(limit);
    return rows as TEntity[];
  }
}
