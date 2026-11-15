
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { ParcelRepository } from './parcel.repository';
import type {
  ParcelColumns,
  ParcelFlatByKind,
  ParcelKind,
  ParcelOfKind,
  ParcelInclude,
  ParcelNoInclude,
  ParcelResult,
} from './parcel.repository';
import { assertBaseOnlyKind } from '@shared/base-classes/inheritance';
import type { DrizzleTx } from '@shared/types/drizzle';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import type { parcels, Parcel } from './parcel.entity';

/** The kinds that have a child table, and the create path that writes both rows for each (`KindRequiresChildError`). */
const PARCEL_CHILD_CREATE_PATH = {
  crate: 'CrateService.create',
} as const;

@Injectable()
export class ParcelService extends WithAnalytics(
  BaseService<ParcelRepository, Parcel>,
) {
  protected override readonly entityName = 'parcel';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: ParcelRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(ParcelService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends ParcelInclude = ParcelNoInclude, C extends ParcelColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<ParcelResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends ParcelInclude = ParcelNoInclude, C extends ParcelColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<ParcelResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends ParcelInclude = ParcelNoInclude, C extends ParcelColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof parcels> & ReadOptions<W, C>,
  ): Promise<Array<ParcelResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // RFC-0006 §3.3 — reading across kinds: the repository's, forwarded.
  findAllKinds(
    query?: ListOptions<typeof parcels> & { kinds?: readonly ParcelKind[] },
  ): Promise<ParcelOfKind[]> {
    return this.repository.findAllKinds(query);
  }

  findKindById(id: string): Promise<ParcelOfKind | null> {
    return this.repository.findKindById(id);
  }

  listKind<K extends keyof ParcelFlatByKind>(
    kind: K,
    query?: ListOptions<typeof parcels>,
  ): Promise<Array<ParcelFlatByKind[K]>> {
    return this.repository.listKind<K>(kind, query);
  }

  countKind(kind: ParcelKind, where?: RowFilter<typeof parcels>): Promise<number> {
    return this.repository.countKind(kind, where);
  }

  findOrphans(opts?: { limit?: number }): Promise<Parcel[]> {
    return this.repository.findOrphans(opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Writes through the base (RFC-0006 §4.1)
  // ═══════════════════════════════════════════════════════════════════════

  /** A kind with a child table is created through the child (`KindRequiresChildError`); a base-only kind is created here. */
  override async create(input: globalThis.Partial<Parcel>, tx?: unknown): Promise<Parcel> {
    assertBaseOnlyKind('parcel', input.kind, PARCEL_CHILD_CREATE_PATH);
    return super.create(input, tx);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
