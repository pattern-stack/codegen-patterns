/**
 * BaseService<TRepo, TEntity>
 *
 * Abstract base class providing 8 CRUD pass-through methods delegating to
 * an injected repository. Every generated service extends this class.
 *
 * Lifecycle event emission (LIFECYCLE + CHANGE categories) is built into
 * create/update/delete — matching pattern-stack's BaseService. Events are
 * fire-and-forget: emission never fails the CRUD operation. If no IEventBus
 * is injected (eventBus is undefined), emission is silently skipped.
 *
 * Generated services set `entityName` and optionally inject `eventBus` via
 * NestJS property injection (@Inject(EVENT_BUS) @Optional()).
 *
 * Note: @Injectable() is applied on concrete services (not here) so that
 * NestJS DI metadata is emitted at the concrete class level. This matches
 * the pattern established by BaseRepository.
 */

import type { IEventBus } from '../subsystems/events/event-bus.protocol';
import {
  entitySnapshot,
  diffSnapshots,
  buildLifecycleEvent,
  buildChangeEvents,
  emitSafely,
} from './lifecycle-events';

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
  /**
   * Entity name for event types (e.g., 'account' → 'account.created').
   * Set by generated services. If empty, lifecycle events are skipped.
   */
  protected entityName?: string;

  /**
   * Event bus for lifecycle/change event emission.
   * Injected via @Inject(EVENT_BUS) @Optional() on generated services.
   * If undefined (no events subsystem installed), emission is silently skipped.
   */
  protected eventBus?: IEventBus;

  /**
   * Whether to emit lifecycle events. Default: true.
   * Override to false in entity YAML via behaviors or in the service class.
   */
  protected emitLifecycleEvents = true;

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
   * Emits a LIFECYCLE 'created' event with entity snapshot.
   */
  async create(input: Partial<TEntity>): Promise<TEntity> {
    const result = await this.repository.create(input);

    if (this._shouldEmit()) {
      const snap = entitySnapshot(result as Record<string, unknown>);
      const id = (result as Record<string, unknown>).id as string;
      const event = buildLifecycleEvent(this.entityName!, 'created', id, snap);
      void emitSafely(this.eventBus, [event]);
    }

    return result;
  }

  /**
   * Update an existing entity by id.
   * Emits a LIFECYCLE 'updated' event + CHANGE events for each modified field.
   */
  async update(id: string, input: Partial<TEntity>): Promise<TEntity> {
    // Snapshot before for change diffing
    let before: Record<string, unknown> | undefined;
    if (this._shouldEmit()) {
      const existing = await this.repository.findById(id);
      if (existing) {
        before = entitySnapshot(existing as Record<string, unknown>);
      }
    }

    const result = await this.repository.update(id, input);

    if (this._shouldEmit()) {
      const after = entitySnapshot(result as Record<string, unknown>);
      const events = [
        buildLifecycleEvent(this.entityName!, 'updated', id, after),
      ];
      // Append per-field CHANGE events
      if (before) {
        const changes = diffSnapshots(before, after);
        if (changes.length > 0) {
          events.push(...buildChangeEvents(this.entityName!, id, changes));
        }
      }
      void emitSafely(this.eventBus, events);
    }

    return result;
  }

  /**
   * Delete an entity by id.
   * Emits a LIFECYCLE 'deleted' event.
   */
  async delete(id: string): Promise<void> {
    await this.repository.delete(id);

    if (this._shouldEmit()) {
      const event = buildLifecycleEvent(this.entityName!, 'deleted', id);
      void emitSafely(this.eventBus, [event]);
    }
  }

  /** Check whether lifecycle event emission is active. */
  private _shouldEmit(): boolean {
    return Boolean(
      this.emitLifecycleEvents &&
      this.entityName &&
      this.eventBus,
    );
  }
}
