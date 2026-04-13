/**
 * MetadataEntityRepository<TEntity>
 *
 * Family-specific base for metadata entities (field values, field history, tags).
 * Adds entity-scoped lookups, type filtering, history ordering, and bulk upsert.
 *
 * Concrete repos extend this and declare their table + behaviors.
 */
import { eq, and, desc } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { BaseRepository } from './base-repository';

export abstract class MetadataEntityRepository<TEntity> extends BaseRepository<TEntity> {
  /**
   * Bulk upsert with a caller-specified conflict target.
   * Uses Drizzle's onConflictDoUpdate to merge records.
   */
  async upsertMany(
    inputs: Array<Partial<TEntity>>,
    conflictTarget: keyof PgTableWithColumns<any>['_']['columns'], // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<TEntity[]> {
    if (inputs.length === 0) return [];

    const data = inputs.map((input) =>
      this.withTimestamps(input as Record<string, unknown>, 'create'),
    );

    const rows = await this.db
      .insert(this.table)
      .values(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .onConflictDoUpdate({
        target: this.table[conflictTarget as string],
        set: data[0] as any, // eslint-disable-line @typescript-eslint/no-explicit-any
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
          eq(this.table['entityId'], entityId),
          eq(this.table['entityType'], entityType),
        ),
      );
    return rows as TEntity[];
  }

  /**
   * List all metadata records for an entity.
   */
  async listByEntityId(entityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['entityId'], entityId));
    return rows as TEntity[];
  }

  /**
   * List metadata history for an entity, ordered by validFrom descending.
   */
  async listHistoryByEntityId(entityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery()
      .where(eq(this.table['entityId'], entityId))
      .orderBy(desc(this.table['validFrom']));
    return rows as TEntity[];
  }
}
