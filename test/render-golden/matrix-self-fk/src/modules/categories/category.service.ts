
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { CategoryRepository } from './category.repository';
import type {
  CategoryColumns,
  CategoryInclude,
  CategoryNoInclude,
  CategoryResult,
} from './category.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { categories, Category } from './category.entity';

@Injectable()
export class CategoryService extends WithAnalytics(
  BaseService<CategoryRepository, Category>,
) {
  protected override readonly entityName = 'category';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: CategoryRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(CategoryService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends CategoryInclude = CategoryNoInclude, C extends CategoryColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CategoryResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends CategoryInclude = CategoryNoInclude, C extends CategoryColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CategoryResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends CategoryInclude = CategoryNoInclude, C extends CategoryColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof categories> & ReadOptions<W, C>,
  ): Promise<Array<CategoryResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Category parent for this Category.
   * Two repo calls: find self by id → find target by FK.
   */
  async parentCategory(categoryId: string): Promise<Category | null> {
    const entity = await this.repository.findById(categoryId);
    if (!entity) return null;
    return entity.parentCategoryId ? this.repository.findById(entity.parentCategoryId) : null;
  }

  /**
   * Fetch children for this Category by FK traversal.
   * Single repo call; `limit` caps it (ordered by `id`, so the subset is stable).
   */
  async children(categoryId: string, opts?: { limit?: number }): Promise<Category[]> {
    return this.repository.findByParentCategoryId(categoryId, opts);
  }
}
