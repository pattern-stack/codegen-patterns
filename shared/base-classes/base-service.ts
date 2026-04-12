/**
 * BaseService<TRepo, TEntity>
 *
 * Abstract base class providing 8 CRUD pass-through methods delegating to
 * an injected repository. Every generated service extends this class.
 *
 * No side effects — pure delegation per ADR-003. Enrichment logic lives in
 * concrete service subclasses or dedicated use cases.
 *
 * Note: @Injectable() is applied on concrete services (not here) so that
 * NestJS DI metadata is emitted at the concrete class level. This matches
 * the pattern established by BaseRepository.
 */

// ============================================================================
// IBaseRepository interface
// ============================================================================

/**
 * Structural interface that BaseRepository satisfies.
 * Use this as the TRepo constraint so BaseService is not coupled to the
 * concrete Drizzle-backed BaseRepository.
 */
export interface IBaseRepository<TEntity> {
  findById(id: string): Promise<TEntity | null>;
  findByIds(ids: string[]): Promise<TEntity[]>;
  list(options?: unknown): Promise<TEntity[]>;
  count(where?: unknown): Promise<number>;
  exists(id: string): Promise<boolean>;
  create(input: Partial<TEntity>): Promise<TEntity>;
  update(id: string, input: Partial<TEntity>): Promise<TEntity>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// BaseService
// ============================================================================

export abstract class BaseService<TRepo extends IBaseRepository<TEntity>, TEntity> {
  constructor(protected readonly repository: TRepo) {}

  /**
   * Find a single entity by its primary key.
   * Returns null if not found.
   */
  findById(id: string): Promise<TEntity | null> {
    return this.repository.findById(id);
  }

  /**
   * Find multiple entities by their primary keys.
   */
  findByIds(ids: string[]): Promise<TEntity[]> {
    return this.repository.findByIds(ids);
  }

  /**
   * List entities with optional filtering/pagination options.
   */
  list(options?: unknown): Promise<TEntity[]> {
    return this.repository.list(options);
  }

  /**
   * Count entities matching an optional filter.
   */
  count(where?: unknown): Promise<number> {
    return this.repository.count(where);
  }

  /**
   * Check whether an entity with the given id exists.
   */
  exists(id: string): Promise<boolean> {
    return this.repository.exists(id);
  }

  /**
   * Insert a new entity.
   */
  create(input: Partial<TEntity>): Promise<TEntity> {
    return this.repository.create(input);
  }

  /**
   * Update an existing entity by id.
   */
  update(id: string, input: Partial<TEntity>): Promise<TEntity> {
    return this.repository.update(id, input);
  }

  /**
   * Delete an entity by id.
   */
  delete(id: string): Promise<void> {
    return this.repository.delete(id);
  }
}
