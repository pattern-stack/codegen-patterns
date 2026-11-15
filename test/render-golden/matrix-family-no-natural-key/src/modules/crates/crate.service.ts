
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { CrateRepository } from './crate.repository';
import type {
  CrateColumns,
  CrateCreate,
  CrateFlat,
  CrateUpdate,
  CrateInclude,
  CrateNoInclude,
  CrateResult,
} from './crate.repository';
import { CRATE_BASE_KEYS } from './crate.repository';
import type { DrizzleTx } from '@shared/types/drizzle';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { crates, Crate } from './crate.entity';

@Injectable()
export class CrateService extends WithAnalytics(
  BaseService<CrateRepository, Crate>,
) {
  protected override readonly entityName = 'crate';

  // RFC-0006 §5, A11 — a child write is announced under the base's name too, with the base's slice of the row.
  protected override readonly baseEntityName = 'parcel';
  protected override readonly baseSliceKeys = CRATE_BASE_KEYS;

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: CrateRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(CrateService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CrateResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CrateResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof crates> & ReadOptions<W, C>,
  ): Promise<Array<CrateResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // RFC-0006 §3.2 — the base row, flat: the repository's `findWithBase` / `findManyWithBase`, forwarded.
  findWithBase<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CrateFlat<W, C> | null> {
    return this.repository.findWithBase<W, C>(id, opts);
  }

  findManyWithBase<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CrateFlat<W, C>>> {
    return this.repository.findManyWithBase<W, C>(ids, opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The pair write (RFC-0006 §4.1) — the repository's, wrapped in BaseService's events
  //
  // The repository's `create` / `update` take the FLAT input (the base's columns and this table's) and return the
  // FLAT row; `BaseService`'s are typed on the table row alone, so these narrow them to what actually flows.
  // ═══════════════════════════════════════════════════════════════════════

  override create(input: CrateCreate, tx?: DrizzleTx): Promise<CrateFlat> {
    return super.create(input as globalThis.Partial<Crate>, tx) as Promise<CrateFlat>;
  }

  override update(id: string, patch: CrateUpdate, tx?: DrizzleTx): Promise<CrateFlat> {
    return super.update(id, patch as globalThis.Partial<Crate>, tx) as Promise<CrateFlat>;
  }

  /** The pre-update read is the FLAT row: against the table's own columns every base field would look changed. */
  protected override readBeforeUpdate(id: string): Promise<Crate | null> {
    return this.repository.findWithBase(id);
  }

  /**
   * The repository's delete is a no-op for an id that is not a crate (a row of another kind is never deleted
   * through this service), so `BaseService`'s events fire only when there was a row of this kind to delete — a
   * `parcel.deleted` for a row that still exists would drop it from every subscriber.
   */
  override async delete(id: string, tx?: unknown): Promise<void> {
    if ((await this.repository.findWithBase(id)) === null) return;
    return super.delete(id, tx);
  }


  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
