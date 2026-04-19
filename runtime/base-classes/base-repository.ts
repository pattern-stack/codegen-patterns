/**
 * BaseRepository<TEntity>
 *
 * Abstract base class providing standard CRUD operations via Drizzle ORM.
 * Every generated repository extends this class.
 *
 * Family-specific bases (CrmEntityRepository, etc.) extend this in v0.1
 * without any changes to BaseRepository.
 *
 * NOT @Injectable — concrete repositories are @Injectable and inject DRIZZLE.
 */
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgTableWithColumns, PgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTx } from '../types/drizzle';

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Behavior flags for the repository. Controls automatic timestamp injection
 * and soft-delete filtering.
 */
export interface BehaviorConfig {
  timestamps: boolean;
  softDelete: boolean;
  userTracking: boolean;
}

/**
 * Options for the list() method.
 */
export interface ListOptions {
  where?: SQL;
  limit?: number;
  offset?: number;
  orderBy?: PgColumn | SQL;
}

// ============================================================================
// BaseRepository
// ============================================================================

export abstract class BaseRepository<TEntity> {
  /**
   * The Drizzle table schema for this entity.
   * Concrete repositories declare this as a class property.
   */
  protected abstract readonly table: PgTableWithColumns<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Behavior flags controlling automatic behavior injection.
   * Override in concrete repositories to enable behaviors.
   */
  protected readonly behaviors: BehaviorConfig = {
    timestamps: false,
    softDelete: false,
    userTracking: false,
  };

  protected readonly db: DrizzleClient;

  constructor(db: DrizzleClient) {
    this.db = db;
  }

  /**
   * Pick the runner for a write: the caller-supplied transaction handle
   * if present, otherwise the repository's own client. Keeps the `tx`
   * parameter purely additive — callers without a transaction call as
   * before. Used by the write methods below + consumer overrides (e.g.
   * the generated `upsertCurrentValues` on EAV value tables).
   */
  protected runner(tx?: DrizzleTx): DrizzleClient {
    return tx ?? this.db;
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Find a single entity by its primary key.
   * Returns null if not found (or soft-deleted when softDelete=true).
   */
  async findById(id: string): Promise<TEntity | null> {
    const rows = await this.baseQuery()
      .where(eq(this.table['id'], id))
      .limit(1);
    return (rows[0] as TEntity) ?? null;
  }

  /**
   * Find multiple entities by their primary keys.
   * Returns empty array immediately for empty input (avoids DB errors).
   */
  async findByIds(ids: string[]): Promise<TEntity[]> {
    if (ids.length === 0) return [];
    const rows = await this.baseQuery().where(inArray(this.table['id'], ids));
    return rows as TEntity[];
  }

  /**
   * List entities with optional filtering, pagination, and ordering.
   */
  async list(options?: ListOptions): Promise<TEntity[]> {
    let query = this.baseQuery();

    if (options?.where) {
      query = query.where(options.where) as typeof query;
    }
    if (options?.orderBy) {
      query = query.orderBy(options.orderBy as SQL) as typeof query;
    }
    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    const rows = await query;
    return rows as TEntity[];
  }

  /**
   * Count entities matching an optional WHERE clause.
   * Soft-deleted rows are always excluded when softDelete=true.
   */
  async count(where?: SQL): Promise<number> {
    let query = this.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(this.table);

    const conditions: SQL[] = [];
    if (this.behaviors.softDelete) {
      conditions.push(isNull(this.table['deletedAt']));
    }
    if (where) {
      conditions.push(where);
    }

    if (conditions.length === 1) {
      query = query.where(conditions[0]) as typeof query;
    } else if (conditions.length > 1) {
      // Combine with AND by building the condition inline
      const { and } = await import('drizzle-orm');
      query = query.where(and(...conditions)) as typeof query;
    }

    const rows = await query;
    return rows[0]?.count ?? 0;
  }

  /**
   * Check whether an entity with the given id exists.
   */
  async exists(id: string): Promise<boolean> {
    const result = await this.findById(id);
    return result !== null;
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Insert a new entity. Timestamps are auto-injected when timestamps=true.
   */
  async create(input: Partial<TEntity>, tx?: DrizzleTx): Promise<TEntity> {
    const data = this.withTimestamps(input as Record<string, unknown>, 'create');
    const rows = await this.runner(tx)
      .insert(this.table)
      .values(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .returning();
    return rows[0] as TEntity;
  }

  /**
   * Update an existing entity by id. updatedAt is auto-injected when timestamps=true.
   * Returns the updated entity.
   */
  async update(id: string, input: Partial<TEntity>, tx?: DrizzleTx): Promise<TEntity> {
    const data = this.withTimestamps(input as Record<string, unknown>, 'update');
    const rows = await this.runner(tx)
      .update(this.table)
      .set(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .where(eq(this.table['id'], id))
      .returning();
    return rows[0] as TEntity;
  }

  /**
   * Delete an entity by id.
   * - softDelete=true: sets deletedAt to current timestamp
   * - softDelete=false: hard-deletes the row
   */
  async delete(id: string, tx?: DrizzleTx): Promise<void> {
    const runner = this.runner(tx);
    if (this.behaviors.softDelete) {
      await runner
        .update(this.table)
        .set({ deletedAt: new Date() } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .where(eq(this.table['id'], id));
    } else {
      await runner
        .delete(this.table)
        .where(eq(this.table['id'], id));
    }
  }

  /**
   * Insert or update multiple entities.
   * Default naive implementation — family repositories override with
   * proper conflict-target upsert (e.g., CrmEntityRepository).
   */
  async upsertMany(inputs: Array<Partial<TEntity>>, tx?: DrizzleTx): Promise<TEntity[]> {
    return Promise.all(inputs.map((input) => this.create(input, tx)));
  }

  // ============================================================================
  // Protected Helpers
  // ============================================================================

  /**
   * Base SELECT query that automatically excludes soft-deleted rows
   * when softDelete behavior is enabled.
   */
  protected baseQuery() {
    const query = this.db.select().from(this.table).$dynamic();
    if (this.behaviors.softDelete) {
      return query.where(isNull(this.table['deletedAt']));
    }
    return query;
  }

  /**
   * Merge timestamp fields into an input object.
   * - mode='create': adds createdAt and updatedAt
   * - mode='update': adds updatedAt only
   *
   * No-op when timestamps behavior is disabled.
   */
  protected withTimestamps(
    input: Record<string, unknown>,
    mode: 'create' | 'update',
  ): Record<string, unknown> {
    if (!this.behaviors.timestamps) return input;
    const now = new Date();
    if (mode === 'create') {
      return { ...input, createdAt: now, updatedAt: now };
    }
    return { ...input, updatedAt: now };
  }

  /**
   * Build a WHERE clause fragment that restricts results to rows whose
   * parent (identified by a belongs_to FK) is not soft-deleted.
   *
   * Use this in custom repository methods when you need "rows reachable
   * from an active parent". The default findAll / findById behavior is
   * NOT changed by this helper — opt in explicitly where needed.
   *
   * ADR-021 — Soft-delete cascade: Option A (filter at query time).
   * `on_delete` FK rules do not fire for soft-deletes; use this helper
   * instead of expecting cascade semantics on the DB level.
   *
   * Example:
   *   async listActiveMessages(): Promise<Message[]> {
   *     return this.list({
   *       where: this.activeParentFilter(conversations, this.table['conversationId']),
   *     });
   *   }
   *
   * @param parentTable  The Drizzle table object for the parent entity.
   * @param parentFkColumn  The FK column on this (child) table that references parent.id.
   */
  protected activeParentFilter(
    parentTable: PgTableWithColumns<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    parentFkColumn: PgColumn,
  ): SQL {
    return sql`EXISTS (
      SELECT 1 FROM ${parentTable} p
      WHERE p.id = ${parentFkColumn}
        AND p.deleted_at IS NULL
    )`;
  }
}
