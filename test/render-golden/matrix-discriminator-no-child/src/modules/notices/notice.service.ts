
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { NoticeRepository } from './notice.repository';
import type {
  NoticeColumns,
  NoticeNoInclude,
  NoticeResult,
} from './notice.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { notices, Notice } from './notice.entity';

@Injectable()
export class NoticeService extends WithAnalytics(
  BaseService<NoticeRepository, Notice>,
) {
  protected override readonly entityName = 'notice';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: NoticeRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(NoticeService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends NoticeColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<NoticeResult<NoticeNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends NoticeColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<NoticeResult<NoticeNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends NoticeColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof notices> & ReadOptions<never, C>,
  ): Promise<Array<NoticeResult<NoticeNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
