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
   *
   * **Not available on a tenant-scoped repository** (ADR-042 / TEN-1 §5.2).
   * The conflict target here is a SINGLE caller-supplied column, backed by an
   * author-declared unique index. Prepending `tenant_id` would break `ON
   * CONFLICT` inference against that index, and NOT prepending it means tenant
   * B's batch updates tenant A's row — an active cross-tenant write. Neither is
   * acceptable, so the combination throws instead. The `conflictTarget`-less
   * path delegates to `create()` and is covered.
   *
   * Known, separate defect on this method (#687): with a conflict target, every
   * conflicting row in the batch is overwritten with `data[0]`'s values rather
   * than its own. Untouched here — it is orthogonal to tenancy, and the path a
   * tenant-scoped repo would take now throws before reaching it.
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

    if (this.behaviors.tenantScoped) {
      throw new Error(
        `${this.constructor.name}.upsertMany: a conflict target ` +
          `('${conflictTarget}') is not supported on a tenant-scoped ` +
          'repository. The ON CONFLICT target decides which row is updated ' +
          'before any WHERE applies, so this upsert would cross the tenant ' +
          'boundary. Call upsertMany without `conflictTarget` (it delegates ' +
          'to create(), which stamps and scopes), or declare a composite ' +
          '(tenant_id, …) unique index and upsert through it. See ADR-042, ' +
          'TEN-1 §5.2 and #703.',
      );
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
    const rows = await this.baseQuery(
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
    const rows = await this.baseQuery(eq(this.col('entityId'), entityId));
    return rows as TEntity[];
  }

  /**
   * List metadata history for an entity, ordered by validFrom descending.
   */
  async listHistoryByEntityId(entityId: string): Promise<TEntity[]> {
    const rows = await this.baseQuery(eq(this.col('entityId'), entityId))
      .orderBy(desc(this.col('validFrom')));
    return rows as TEntity[];
  }
}
