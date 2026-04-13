/**
 * BaseRepository — minimal implementation for scaffold validation.
 *
 * Provides the CRUD interface that generated repositories inherit.
 * Generated repositories call: findById, list, create, update, delete.
 * This scaffold stub uses Drizzle directly with a generic table reference.
 */
import { eq, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '../types/drizzle';

export abstract class BaseRepository<TEntity extends { id: string }> {
  protected abstract readonly table: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  protected readonly db: DrizzleClient;

  constructor(db: DrizzleClient) {
    this.db = db;
  }

  async findById(id: string): Promise<TEntity | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.id, id));
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
    const rows = await this.db.select().from(this.table);
    // Filter soft-deleted rows if deletedAt column exists
    return (rows as TEntity[]).filter((r: any) => r.deletedAt == null); // eslint-disable-line @typescript-eslint/no-explicit-any
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
      .insert(this.table)
      .values(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .returning();
    return rows[0] as TEntity;
  }

  async update(id: string, data: Partial<TEntity>): Promise<TEntity | null> {
    const rows = await this.db
      .update(this.table)
      .set({ ...data, updatedAt: new Date() } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .where(eq(this.table.id, id))
      .returning();
    return (rows[0] as TEntity) ?? null;
  }

  async delete(id: string): Promise<TEntity | null> {
    // Soft-delete: set deletedAt if the column exists, otherwise hard-delete
    const row = await this.findById(id);
    if (!row) return null;

    if ('deletedAt' in this.table) {
      const rows = await this.db
        .update(this.table)
        .set({ deletedAt: new Date() } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .where(eq(this.table.id, id))
        .returning();
      return (rows[0] as TEntity) ?? null;
    }

    const rows = await this.db
      .delete(this.table)
      .where(eq(this.table.id, id))
      .returning();
    return (rows[0] as TEntity) ?? null;
  }

  async upsertMany(items: Partial<TEntity>[]): Promise<TEntity[]> {
    const results: TEntity[] = [];
    for (const item of items) {
      if ((item as any).id) { // eslint-disable-line @typescript-eslint/no-explicit-any
        const updated = await this.update((item as any).id, item); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (updated) results.push(updated);
      } else {
        const created = await this.create(item as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        results.push(created);
      }
    }
    return results;
  }
}
