
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { AirFreightRepository } from './air-freight.repository';
import type {
  AirFreightColumns,
  AirFreightCreate,
  AirFreightFlat,
  AirFreightUpdate,
  AirFreightInclude,
  AirFreightNoInclude,
  AirFreightResult,
} from './air-freight.repository';
import { AIR_FREIGHT_BASE_KEYS } from './air-freight.repository';
import type { DrizzleTx } from '@shared/types/drizzle';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import type { air_freights, AirFreight } from './air-freight.entity';
import type { shipments } from '../shipments/shipment.entity';

@Injectable()
export class AirFreightService extends WithAnalytics(
  BaseService<AirFreightRepository, AirFreight>,
) {
  protected override readonly entityName = 'air_freight';

  // RFC-0006 §5, A11 — a child write is announced under the base's name too, with the base's slice of the row.
  protected override readonly baseEntityName = 'shipment';
  protected override readonly baseSliceKeys = AIR_FREIGHT_BASE_KEYS;

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: AirFreightRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(AirFreightService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends AirFreightInclude = AirFreightNoInclude, C extends AirFreightColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<AirFreightResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends AirFreightInclude = AirFreightNoInclude, C extends AirFreightColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<AirFreightResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends AirFreightInclude = AirFreightNoInclude, C extends AirFreightColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof air_freights> & ReadOptions<W, C>,
  ): Promise<Array<AirFreightResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // RFC-0006 §3.2 — the base row, flat: the repository's `findWithBase` / `findManyWithBase`, forwarded.
  findWithBase<W extends AirFreightInclude & { shipment?: never } = AirFreightNoInclude, C extends AirFreightColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<AirFreightFlat<W, C> | null> {
    return this.repository.findWithBase<W, C>(id, opts);
  }

  findManyWithBase<W extends AirFreightInclude & { shipment?: never } = AirFreightNoInclude, C extends AirFreightColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<AirFreightFlat<W, C>>> {
    return this.repository.findManyWithBase<W, C>(ids, opts);
  }

  /** This kind's rows, flat, filtered and sorted on the base's columns — the base's `listKind` (RFC-0006 §3.3). What the HTTP list reads. */
  listFlat<W extends AirFreightInclude = AirFreightNoInclude>(
    query?: ListOptions<typeof shipments>,
    opts?: { with?: W },
  ): Promise<Array<AirFreightFlat<W>>> {
    return this.repository.listFlat<W>(query, opts);
  }

  /** How many rows `listFlat` ranges over, on the same scope. */
  countFlat(where?: RowFilter<typeof shipments>): Promise<number> {
    return this.repository.countFlat(where);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The pair write (RFC-0006 §4.1) — the repository's, wrapped in BaseService's events
  //
  // The repository's `create` / `update` take the FLAT input (the base's columns and this table's) and return the
  // FLAT row; `BaseService`'s are typed on the table row alone, so these narrow them to what actually flows.
  // ═══════════════════════════════════════════════════════════════════════

  override create(input: AirFreightCreate, tx?: DrizzleTx): Promise<AirFreightFlat> {
    return super.create(input as globalThis.Partial<AirFreight>, tx) as Promise<AirFreightFlat>;
  }

  /** Not a air_freight in scope: nothing is written (the repository's update is a no-op) and nothing is emitted — `BaseService` would snapshot `undefined`. */
  override async update(id: string, patch: AirFreightUpdate, tx?: DrizzleTx): Promise<AirFreightFlat> {
    if ((await this.repository.findWithBase(id)) === null) return undefined as unknown as AirFreightFlat;
    return super.update(id, patch as globalThis.Partial<AirFreight>, tx) as Promise<AirFreightFlat>;
  }

  /** The pre-update read is the FLAT row: against the table's own columns every base field would look changed. */
  protected override readBeforeUpdate(id: string): Promise<AirFreight | null> {
    return this.repository.findWithBase(id);
  }

  /**
   * The repository's delete is a no-op for an id that is not a air_freight (a row of another kind is never deleted
   * through this service), so `BaseService`'s events fire only when there was a row of this kind to delete — a
   * `shipment.deleted` for a row that still exists would drop it from every subscriber.
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
