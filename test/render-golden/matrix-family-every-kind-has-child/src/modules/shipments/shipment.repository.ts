
import { Injectable, Inject } from '@nestjs/common';

import { eq, inArray } from 'drizzle-orm';
import { and, notExists, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient, DrizzleTx } from '@shared/types/drizzle';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '../../generated/relations';
import { BaseRepository } from '@shared/base-classes/base-repository';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import { asKind, flattenBase, KindImmutableError, type Flattened } from '@shared/base-classes/inheritance';
import { shipments, type Shipment } from './shipment.entity';
import { air_freights, type AirFreight } from '../air-freights/air-freight.entity';
import { sea_freights, type SeaFreight } from '../sea-freights/sea-freight.entity';

/**
 * The root column mask a shipment read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type ShipmentColumns = ColumnsOf<'shipments'>;

/**
 * The relation keys a shipment read may include — the `with` surface of
 * `shipments` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type ShipmentInclude = IncludeOf<'shipments'>;

/** The default `TWith` — no include. */
export type ShipmentNoInclude = globalThis.Record<string, never>;

/**
 * The row a shipment read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `ShipmentResult` alone is the plain row; `ShipmentResult<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `ShipmentResult<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type ShipmentResult<
  TWith extends ShipmentInclude = ShipmentNoInclude,
  TColumns extends ShipmentColumns | undefined = undefined,
> = ResultOf<'shipments', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `ShipmentResult<ShipmentInclude>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type ShipmentApiResult = Shipment &
  globalThis.Partial<ShipmentResult<ShipmentInclude>>;

/** The kinds of a shipment: the discriminator's choices. */
export type ShipmentKind = Shipment['kind'];

/**
 * A shipment read across its kinds (RFC-0006 §3.3): each child nested under its own key, a
 * base-only kind bare. Narrow it with a `switch` on `kind`.
 */
export type ShipmentOfKind =
  | (Shipment & { kind: 'air'; airFreight: AirFreight })
  | (Shipment & { kind: 'sea'; seaFreight: SeaFreight });

/** One kind, flat: the base's columns and the child's, at one level. What `listKind` returns. */
export interface ShipmentFlatByKind {
  air: Flattened<Shipment & { airFreight: AirFreight }, 'airFreight'>;
  sea: Flattened<Shipment & { seaFreight: SeaFreight }, 'seaFreight'>;
}

/** The relation key each child kind is read under, and the one `asKind` narrows by. */
const SHIPMENT_CHILD_KEY_BY_KIND = {
  air: 'airFreight',
  sea: 'seaFreight',
} as const;

/** The children a read of these kinds joins — only the kinds asked for, all of them when none are. */
function shipmentKindJoins(kinds: readonly ShipmentKind[] | undefined): {
  airFreight?: true;
  seaFreight?: true;
} {
  return {
    ...(kinds === undefined || kinds.includes('air') ? { airFreight: true as const } : {}),
    ...(kinds === undefined || kinds.includes('sea') ? { seaFreight: true as const } : {}),
  };
}

/**
 * The orphan predicate: a row whose kind has a child table but no child row (RFC-0006 §2.2). A module-level
 * function with camelCase bindings only, because it reads the children's table exports (emitted-name hygiene, #813).
 */
function shipmentOrphanFilter(dbClient: DrizzleClient<Relations>, rootRow: typeof shipments) {
  return or(
    and(
      eq(rootRow.kind, 'air'),
      notExists(dbClient.select({ one: sql`1` }).from(air_freights).where(eq(air_freights.id, rootRow.id))),
    ),
    and(
      eq(rootRow.kind, 'sea'),
      notExists(dbClient.select({ one: sql`1` }).from(sea_freights).where(eq(sea_freights.id, rootRow.id))),
    ),
  );
}

@Injectable()
export class ShipmentRepository extends BaseRepository<Shipment, typeof shipments, Relations> {
  readonly table = shipments;

  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
    // Every read runs on db.query.shipments — fail HERE, naming the cause,
    // if the injected client was built without the relations manifest.
    this.requireRelationalQuery('shipments');
    // findById / findByIds / list are defined below, so a pattern base class or
    // capability mixin overriding one of them would never run — throw, naming it.
    this.claimGeneratedReads(ShipmentRepository);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1, docs/specs/READ-1.md; REL-2 #587)
  //
  // Every read takes the same shape knobs — a root `columns` mask and a
  // typed `with` include — inferred at the call site. The signatures live HERE,
  // not on the base: with `TRelations` and the table key as naked type
  // parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2 §2.1).
  //
  // ONE execution path for the read surface below — `findById`, `findByIds`,
  // `list` and every plain `queries:` / `belongs_to` finder run on RQBv2
  // (`db.query.shipments`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"shipments" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<ShipmentResult<W, C> | null> {
    const row = await this.db.query.shipments.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
    });
    return (row as ShipmentResult<W, C> | undefined) ?? null;
  }

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async findByIds<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<ShipmentResult<W, C>>> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.shipments.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,
      with: opts?.with,
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<ShipmentResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async list<W extends ShipmentInclude = ShipmentNoInclude, C extends ShipmentColumns | undefined = undefined>(
    query?: ListOptions<typeof shipments> & ReadOptions<W, C>,
  ): Promise<Array<ShipmentResult<W, C>>> {
    const sort = query?.sort;
    const rows = await this.db.query.shipments.findMany({
      where: { RAW: this.rootFilter(query?.where) },
      columns: this.checkColumns<C>(query?.columns),
      with: query?.with,
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows as Array<ShipmentResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async count(where?: RowFilter<typeof shipments>): Promise<number> {
    return super.count(where);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Reading across kinds (RFC-0006 §3.3, §6, #875)
  //
  // The base scan plus ONE primary-key lateral join per child kind asked for —
  // a single statement (charter I4), on the same root scope as every read here.
  // Each child is scoped by the relations manifest like any other hop.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Every row with its child nested under its kind's key, a base-only kind bare. `kinds` filters the scan
   * and joins only those children. A row whose kind has a child table but no child row throws
   * `OrphanBaseError` (see `findOrphans`).
   */
  async findAllKinds(
    query?: ListOptions<typeof shipments> & { kinds?: readonly ShipmentKind[] },
  ): Promise<ShipmentOfKind[]> {
    const kinds = query?.kinds;
    const sort = query?.sort;
    const rows = await this.db.query.shipments.findMany({
      where: { RAW: this.rootFilter((t) =>
        and(query?.where?.(t), kinds === undefined ? undefined : inArray(t.kind, [...kinds])),
      ) },
      with: shipmentKindJoins(kinds),
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows.map((row) => asKind<ShipmentOfKind>(row, 'kind', SHIPMENT_CHILD_KEY_BY_KIND));
  }

  /** One row by id with its child, narrowed by kind. `null` when absent or out of scope. */
  async findKindById(id: string): Promise<ShipmentOfKind | null> {
    const row = await this.db.query.shipments.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      with: shipmentKindJoins(undefined),
    });
    return row ? asKind<ShipmentOfKind>(row, 'kind', SHIPMENT_CHILD_KEY_BY_KIND) : null;
  }

  /**
   * One kind, flat (the base's columns and the child's at one level), filtered and sorted on BASE columns —
   * the read a child's HTTP list uses, since `created_at` and `occurred_at` live here.
   *
   * `childWith` is an include tree for the CHILD's own includes (`{ transcripts: true }`): it is joined under the
   * child's relation key in the same statement (charter I4), so a child list with an include is still one statement.
   */
  async listKind<K extends keyof ShipmentFlatByKind>(
    kind: K,
    query?: ListOptions<typeof shipments>,
    childWith?: globalThis.Record<string, unknown>,
  ): Promise<Array<ShipmentFlatByKind[K]>> {
    const sort = query?.sort;
    const rows = await this.db.query.shipments.findMany({
      where: { RAW: this.rootFilter((t) => and(eq(t.kind, kind), query?.where?.(t))) },
      with:
        childWith === undefined
          ? shipmentKindJoins([kind])
          : ({ [SHIPMENT_CHILD_KEY_BY_KIND[kind]]: { with: childWith } } as never),
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows.map((row) =>
      flattenBase(
        asKind<ShipmentOfKind>(row, 'kind', SHIPMENT_CHILD_KEY_BY_KIND) as never,
        SHIPMENT_CHILD_KEY_BY_KIND[kind],
      ),
    ) as unknown as Array<ShipmentFlatByKind[K]>;
  }

  /** How many rows of one kind, on the same scope as `count`. */
  async countKind(kind: ShipmentKind, where?: RowFilter<typeof shipments>): Promise<number> {
    return this.count((t) => and(eq(t.kind, kind), where?.(t)));
  }

  /**
   * Rows whose kind has a child table but no child row — the integrity the database cannot enforce (the base
   * is inserted first, RFC-0006 §2.2). For jobs and tests; the generated write path never produces one. One
   * statement, on the base's root scope: a child row is looked for whatever ITS scope says, because an absent
   * child is the question.
   */
  async findOrphans(opts?: { limit?: number }): Promise<Shipment[]> {
    const rows = await this.db.query.shipments.findMany({
      where: { RAW: this.rootFilter((t) => shipmentOrphanFilter(this.db, t)) },
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Shipment[];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Writes through the base (RFC-0006 §4.1, #875)
  // ═══════════════════════════════════════════════════════════════════════

  /** Refuses a `kind` key: a row does not change kind. The database refuses it for any row with a child. */
  override async update(id: string, input: globalThis.Partial<Shipment>, tx?: DrizzleTx): Promise<Shipment> {
    if (input.kind !== undefined) throw new KindImmutableError('shipment');
    return super.update(id, input, tx);
  }

  // Inherited from BaseRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
}
