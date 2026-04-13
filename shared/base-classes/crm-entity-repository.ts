/**
 * CrmEntityRepository<TEntity>
 *
 * Family-specific base for CRM-synced entities (contacts, accounts, opportunities).
 * Adds external ID lookups, user-scoped queries, and sync stubs.
 *
 * Concrete repos extend this and declare their table + behaviors.
 */
import { eq, inArray } from 'drizzle-orm';
import { BaseRepository } from './base-repository';

export abstract class CrmEntityRepository<TEntity> extends BaseRepository<TEntity> {
  /**
   * Find a single entity by its external CRM identifier.
   */
  async findByExternalId(externalId: string): Promise<TEntity | null> {
    const rows = await this.baseQuery()
      .where(eq(this.table['externalId'], externalId))
      .limit(1);
    return (rows[0] as TEntity) ?? null;
  }

  /**
   * Find multiple entities by external CRM identifiers.
   */
  async findManyByExternalIds(externalIds: string[]): Promise<TEntity[]> {
    if (externalIds.length === 0) return [];
    const rows = await this.baseQuery()
      .where(inArray(this.table['externalId'], externalIds));
    return rows as TEntity[];
  }

  /**
   * Find all entities owned by a specific user.
   */
  async findAllByUserId(userId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['userId'], userId));
    return rows as TEntity[];
  }

  /**
   * Sync upsert — bulk insert-or-update from external CRM data.
   * Concrete repositories must implement with the appropriate conflict target.
   */
  async syncUpsert(_inputs: Array<Partial<TEntity>>): Promise<TEntity[]> {
    throw new Error('syncUpsert not implemented — override in concrete repository');
  }

  /**
   * Find entities visible to a user (ownership + sharing rules).
   * Concrete repositories must implement with visibility logic.
   */
  async findVisibleByUserId(_userId: string): Promise<TEntity[]> {
    throw new Error('findVisibleByUserId not implemented — override in concrete repository');
  }
}
