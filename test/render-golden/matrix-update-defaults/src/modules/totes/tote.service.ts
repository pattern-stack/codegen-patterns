
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { ToteRepository } from './tote.repository';
import type {
  ToteColumns,
  ToteFlatByKind,
  ToteKind,
  ToteOfKind,
  ToteInclude,
  ToteNoInclude,
  ToteResult,
} from './tote.repository';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import type { totes, Tote } from './tote.entity';

@Injectable()
export class ToteService extends WithAnalytics(
  BaseService<ToteRepository, Tote>,
) {
  protected override readonly entityName = 'tote';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: ToteRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(ToteService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends ToteInclude = ToteNoInclude, C extends ToteColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<ToteResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends ToteInclude = ToteNoInclude, C extends ToteColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<ToteResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends ToteInclude = ToteNoInclude, C extends ToteColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof totes> & ReadOptions<W, C>,
  ): Promise<Array<ToteResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // RFC-0006 §3.3 — reading across kinds: the repository's, forwarded.
  findAllKinds(
    query?: ListOptions<typeof totes> & { kinds?: readonly ToteKind[] },
  ): Promise<ToteOfKind[]> {
    return this.repository.findAllKinds(query);
  }

  findKindById(id: string): Promise<ToteOfKind | null> {
    return this.repository.findKindById(id);
  }

  listKind<K extends keyof ToteFlatByKind>(
    kind: K,
    query?: ListOptions<typeof totes>,
  ): Promise<Array<ToteFlatByKind[K]>> {
    return this.repository.listKind<K>(kind, query);
  }

  countKind(kind: ToteKind, where?: RowFilter<typeof totes>): Promise<number> {
    return this.repository.countKind(kind, where);
  }

  findOrphans(opts?: { limit?: number }): Promise<Tote[]> {
    return this.repository.findOrphans(opts);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
