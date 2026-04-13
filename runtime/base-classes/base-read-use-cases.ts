/**
 * Base read use cases
 *
 * Abstract base classes for auto-generated per-entity read use cases.
 * Controllers always import use case classes — never services directly (ADR-003).
 *
 * Each entity gets a single generated file with two named exports:
 *   - ContactFindByIdUseCase extends BaseFindByIdUseCase<ContactService, Contact>
 *   - ContactListUseCase extends BaseListUseCase<ContactService, Contact>
 *
 * Note: @Injectable() is applied on concrete use case classes (not here),
 * matching the pattern established by BaseRepository and BaseService.
 */

// ============================================================================
// BaseFindByIdUseCase
// ============================================================================

/**
 * Structural interface for any service that supports findById.
 * Keeps base use cases decoupled from concrete service implementations.
 */
export interface IFindByIdService<TEntity> {
  findById(id: string): Promise<TEntity | null>;
}

/**
 * Base class for generated FindById use cases.
 *
 * Generated usage:
 * ```typescript
 * @Injectable()
 * export class ContactFindByIdUseCase extends BaseFindByIdUseCase<ContactService, Contact> {
 *   constructor(service: ContactService) { super(service); }
 * }
 * ```
 */
export abstract class BaseFindByIdUseCase<
  TService extends IFindByIdService<TEntity>,
  TEntity,
> {
  constructor(protected readonly service: TService) {}

  /**
   * Find a single entity by its primary key.
   * Returns null if not found.
   */
  execute(id: string): Promise<TEntity | null> {
    return this.service.findById(id);
  }
}

// ============================================================================
// BaseListUseCase
// ============================================================================

/**
 * Structural interface for any service that supports list.
 */
export interface IListService<TEntity> {
  list(options?: unknown): Promise<TEntity[]>;
}

/**
 * Base class for generated List use cases.
 *
 * Generated usage:
 * ```typescript
 * @Injectable()
 * export class ContactListUseCase extends BaseListUseCase<ContactService, Contact> {
 *   constructor(service: ContactService) { super(service); }
 * }
 * ```
 */
export abstract class BaseListUseCase<
  TService extends IListService<TEntity>,
  TEntity,
> {
  constructor(protected readonly service: TService) {}

  /**
   * List all entities (no filters).
   * Controllers that need filtered lists should use a dedicated use case.
   */
  execute(): Promise<TEntity[]> {
    return this.service.list();
  }
}
