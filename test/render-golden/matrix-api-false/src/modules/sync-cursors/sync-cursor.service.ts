
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { SyncCursorRepository } from './sync-cursor.repository';
import type {
  SyncCursorColumns,
  SyncCursorInclude,
  SyncCursorNoInclude,
  SyncCursorResult,
} from './sync-cursor.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { sync_cursors, SyncCursor } from './sync-cursor.entity';
import { AccountRepository } from '../accounts/account.repository';
import type { Account } from '../accounts/account.entity';

@Injectable()
export class SyncCursorService extends WithAnalytics(
  BaseService<SyncCursorRepository, SyncCursor>,
) {
  protected override readonly entityName = 'sync_cursor';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: SyncCursorRepository,
    private readonly accountRepo: AccountRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(SyncCursorService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends SyncCursorInclude = SyncCursorNoInclude, C extends SyncCursorColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<SyncCursorResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends SyncCursorInclude = SyncCursorNoInclude, C extends SyncCursorColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<SyncCursorResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends SyncCursorInclude = SyncCursorNoInclude, C extends SyncCursorColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof sync_cursors> & ReadOptions<W, C>,
  ): Promise<Array<SyncCursorResult<W, C>>> {
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
   * Fetch the Account parent for this SyncCursor.
   * Two repo calls: find self by id → find target by FK.
   */
  async account(syncCursorId: string): Promise<Account | null> {
    const entity = await this.repository.findById(syncCursorId);
    if (!entity) return null;
    return entity.accountId ? this.accountRepo.findById(entity.accountId) : null;
  }
}
