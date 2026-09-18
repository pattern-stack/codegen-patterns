/**
 * BaseRepository — minimal implementation for scaffold validation.
 *
 * Provides the CRUD interface that generated repositories inherit.
 * Generated repositories call: findById, list, create, update, delete.
 * This scaffold stub uses Drizzle directly with a generic table reference.
 *
 * NOTE (REL-0, #603): this is a SECOND declaration of a contract the runtime
 * owns (`runtime/base-classes/base-repository.ts`), and it shadows the real one
 * for `just test-integration` (`@shared/base-classes/*` resolves scaffold-first).
 * Its CRUD contract has drifted — `delete()`/`update()` return the row here and
 * `void`/`TEntity` in the runtime — so collapsing the two is a contract decision,
 * not a type change, and is tracked separately. REL-0 only brings the table
 * typing into line: `TTable` is the second type parameter, statements go through
 * the widened `tableRef`, and columns resolve via `getColumns`.
 */
import { eq, getColumns, isNull } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleClient } from '@shared/types/drizzle';

export abstract class BaseRepository<
  TEntity extends { id: string },
  TTable extends PgTable,
> {
  protected abstract readonly table: TTable;
  protected readonly db: DrizzleClient;

  constructor(db: DrizzleClient) {
    this.db = db;
  }

  /** The table widened to the non-generic `PgTable` the builders resolve. */
  protected get tableRef(): PgTable {
    return this.table;
  }

  /** Resolve a column by camelCase key; throws when the table has no such column. */
  protected col(name: string): PgColumn {
    const col: PgColumn | undefined = getColumns(this.tableRef)[name];
    if (!col) throw new Error(`${this.constructor.name}: table has no column '${name}'`);
    return col;
  }

  async findById(id: string): Promise<TEntity | null> {
    const rows = await this.db
      .select()
      .from(this.tableRef)
      .where(eq(this.col('id'), id));
    return (rows[0] as TEntity) ?? null;
  }

  async findByIds(ids: string[]): Promise<TEntity[]> {
    if (ids.length === 0) return [];
    const results: TEntity[] = [];
    for (const id of ids) {
      const row = await this.findById(id);
      if (row) results.push(row);
    }
    return results;
  }

  async list(): Promise<TEntity[]> {
    const rows = await this.db.select().from(this.tableRef);
    // Filter soft-deleted rows if deletedAt column exists
    return (rows as unknown as TEntity[]).filter(
      (r) => (r as { deletedAt?: unknown }).deletedAt == null,
    );
  }

  async count(): Promise<number> {
    const rows = await this.list();
    return rows.length;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.findById(id);
    return row != null;
  }

  async create(data: Omit<TEntity, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<TEntity> {
    const rows = await this.db
      .insert(this.tableRef)
      .values(data as Record<string, unknown>)
      .returning();
    return rows[0] as TEntity;
  }

  async update(id: string, data: Partial<TEntity>): Promise<TEntity | null> {
    const rows = await this.db
      .update(this.tableRef)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(this.col('id'), id))
      .returning();
    return (rows[0] as TEntity) ?? null;
  }

  async delete(id: string): Promise<TEntity | null> {
    // Soft-delete: set deletedAt if the column exists, otherwise hard-delete
    const row = await this.findById(id);
    if (!row) return null;

    if (getColumns(this.tableRef)['deletedAt']) {
      const rows = await this.db
        .update(this.tableRef)
        .set({ deletedAt: new Date() })
        .where(eq(this.col('id'), id))
        .returning();
      return (rows[0] as TEntity) ?? null;
    }

    const rows = await this.db
      .delete(this.tableRef)
      .where(eq(this.col('id'), id))
      .returning({ id: this.col('id') });
    return (rows[0] as TEntity) ?? null;
  }

  async upsertMany(items: Partial<TEntity>[]): Promise<TEntity[]> {
    const results: TEntity[] = [];
    for (const item of items) {
      const id = (item as { id?: string }).id;
      if (id) {
        const updated = await this.update(id, item);
        if (updated) results.push(updated);
      } else {
        const created = await this.create(
          item as Omit<TEntity, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
        );
        results.push(created);
      }
    }
    return results;
  }
}
