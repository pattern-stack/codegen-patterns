
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { ShipmentRepository } from './shipment.repository';
import type {
  ShipmentColumns,
  ShipmentFlatByKind,
  ShipmentKind,
  ShipmentOfKind,
  ShipmentInclude,
  ShipmentNoInclude,
  ShipmentResult,
} from './shipment.repository';
import { assertBaseOnlyKind } from '@shared/base-classes/inheritance';
import type { DrizzleTx } from '@shared/types/drizzle';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import type { shipments, Shipment } from './shipment.entity';

/** The kinds that have a child table, and the create path that writes both rows for each (`KindRequiresChildError`). */
const SHIPMENT_CHILD_CREATE_PATH = {
  air: 'POST /air_freights',
  sea: 'POST /sea_freights',
} as const;

@Injectable()
export class ShipmentService extends WithAnalytics(
  BaseService<ShipmentRepository, Shipment>,
) {
  protected override readonly entityName = 'shipment';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: ShipmentRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(ShipmentService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<ShipmentResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<ShipmentResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof shipments> & ReadOptions<W, C>,
  ): Promise<Array<ShipmentResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // RFC-0006 §3.3 — reading across kinds: the repository's, forwarded.
  findAllKinds(
    query?: ListOptions<typeof shipments> & { kinds?: readonly ShipmentKind[] },
  ): Promise<ShipmentOfKind[]> {
    return this.repository.findAllKinds(query);
  }

  findKindById(id: string): Promise<ShipmentOfKind | null> {
    return this.repository.findKindById(id);
  }

  listKind<K extends keyof ShipmentFlatByKind>(
    kind: K,
    query?: ListOptions<typeof shipments>,
  ): Promise<Array<ShipmentFlatByKind[K]>> {
    return this.repository.listKind<K>(kind, query);
  }

  countKind(kind: ShipmentKind, where?: RowFilter<typeof shipments>): Promise<number> {
    return this.repository.countKind(kind, where);
  }

  findOrphans(opts?: { limit?: number }): Promise<Shipment[]> {
    return this.repository.findOrphans(opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Writes through the base (RFC-0006 §4.1)
  // ═══════════════════════════════════════════════════════════════════════

  /** A kind with a child table is created through the child (`KindRequiresChildError`); a base-only kind is created here. */
  override async create(input: globalThis.Partial<Shipment>, tx?: unknown): Promise<Shipment> {
    assertBaseOnlyKind('shipment', input.kind, SHIPMENT_CHILD_CREATE_PATH);
    return super.create(input, tx);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
