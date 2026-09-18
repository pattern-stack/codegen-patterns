/**
 * MetadataEntityRepository<TEntity, TTable>
 *
 * Family-specific base for metadata entities (field values, field history, tags).
 * Adds entity-scoped lookups, type filtering, history ordering, and bulk upsert.
 *
 * Concrete repos extend this and declare their table + behaviors.
 */
import { eq, and, desc } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { BaseRepository } from './base-repository';
import type { DrizzleTx } from '../types/drizzle';

export abstract class MetadataEntityRepository<
  TEntity,
  TTable extends PgTable,
> extends BaseRepository<TEntity, TTable> {
  /**
   * Bulk upsert with a caller-specified conflict target.
   * Uses Drizzle's onConflictDoUpdate to merge records.
   */
  override async upsertMany(
    inputs: Array<Partial<TEntity>>,
    tx?: DrizzleTx,
    options?: { conflictTarget?: keyof TTable['_']['columns'] & string },
  ): Promise<TEntity[]> {
    if (inputs.length === 0) return [];
    const conflictTarget = options?.conflictTarget;

    // Fall back to base class naive upsert when no conflict target provided.
    if (!conflictTarget) {
      return super.upsertMany(inputs, tx);
    }

    const data = inputs.map((input) =>
      this.withTimestamps(input as Record<string, unknown>, 'create'),
    );

    const rows = await this.runner(tx)
      .insert(this.tableRef)
      .values(data)
      .onConflictDoUpdate({
        target: this.col(conflictTarget),
        set: data[0] ?? {},
      })
      .returning();

    return rows as TEntity[];
  }

  /**
   * Find metadata by entity ID and entity type (compound lookup).
   */
  async findByEntityIdAndType(entityId: string, entityType: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(
        and(
          eq(this.col('entityId'), entityId),
          eq(this.col('entityType'), entityType),
        ),
      );
    return rows as TEntity[];
  }

  /**
   * List all metadata records for an entity.
   */
  async listByEntityId(entityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.col('entityId'), entityId));
    return rows as TEntity[];
  }

  /**
   * List metadata history for an entity, ordered by validFrom descending.
   */
  async listHistoryByEntityId(entityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.col('entityId'), entityId))
      .orderBy(desc(this.col('validFrom')));
    return rows as TEntity[];
  }
}
