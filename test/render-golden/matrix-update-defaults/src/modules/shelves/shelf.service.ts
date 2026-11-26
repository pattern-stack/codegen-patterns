
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { ShelfRepository } from './shelf.repository';
import type {
  ShelfColumns,
  ShelfNoInclude,
  ShelfResult,
} from './shelf.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { shelves, Shelf } from './shelf.entity';

@Injectable()
export class ShelfService extends WithAnalytics(
  BaseService<ShelfRepository, Shelf>,
) {
  protected override readonly entityName = 'shelf';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: ShelfRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(ShelfService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends ShelfColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<ShelfResult<ShelfNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends ShelfColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<ShelfResult<ShelfNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends ShelfColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof shelves> & ReadOptions<never, C>,
  ): Promise<Array<ShelfResult<ShelfNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
