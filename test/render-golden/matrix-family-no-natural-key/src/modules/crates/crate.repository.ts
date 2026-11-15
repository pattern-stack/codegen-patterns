
import { Injectable, Inject } from '@nestjs/common';

import { eq, inArray, getTableColumns } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient, DrizzleTx } from '@shared/types/drizzle';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '../../generated/relations';
import { BaseRepository } from '@shared/base-classes/base-repository';
import type { ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import { flattenBase, inTransaction, KindImmutableError, KindMismatchError, PAIR_WRITE, splitByOwner, type Flattened } from '@shared/base-classes/inheritance';
import { crates, type Crate } from './crate.entity';
import { parcels, type Parcel } from '../parcels/parcel.entity';
import { ParcelRepository } from '../parcels/parcel.repository';

/**
 * The root column mask a crate read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type CrateColumns = ColumnsOf<'crates'>;

/**
 * The relation keys a crate read may include — the `with` surface of
 * `crates` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type CrateInclude = IncludeOf<'crates'>;

/** The default `TWith` — no include. */
export type CrateNoInclude = globalThis.Record<string, never>;

/**
 * The row a crate read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `CrateResult` alone is the plain row; `CrateResult<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `CrateResult<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type CrateResult<
  TWith extends CrateInclude = CrateNoInclude,
  TColumns extends CrateColumns | undefined = undefined,
> = ResultOf<'crates', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `CrateResult<CrateInclude>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 *
 * A child's HTTP result is FLAT (RFC-0006 §5): the base's columns are in the body, so the base relation is never an
 * include and never needs an allowlist entry.
 */
export type CrateApiResult = CrateFlat &
  globalThis.Partial<globalThis.Omit<CrateResult<CrateInclude>, 'parcel'>>;

/**
 * A crate with its base row's columns hoisted to the root (RFC-0006 §3.2) — a projection of ONE
 * read (Crate's table plus a primary-key join to the base), never a second query path. `columns`, `with`
 * and the scope apply to the read that produced it.
 */
export type CrateFlat<
  TWith extends CrateInclude = CrateNoInclude,
  TColumns extends CrateColumns | undefined = undefined,
> = Flattened<
  CrateResult<
    // The default include is `Record<string, never>`: its index signature would make the base key `never` and the whole
    // flat row `never`. Keep the keys the caller named, drop the signature.
    { [K in keyof TWith as string extends K ? never : K]: TWith[K] } & { parcel: true },
    TColumns
  >,
  'parcel'
>;

/**
 * The flat input of a crate write (RFC-0006 §4.1): the base's columns and this table's, at one level.
 * `kind` is fixed by the child ('crate') and is not an input. An update takes the same shape, every key optional.
 */
export type CrateCreate = globalThis.Partial<globalThis.Omit<Parcel, 'kind'>> &
  globalThis.Partial<globalThis.Omit<Crate, 'kind'>>;
export type CrateUpdate = CrateCreate;

/** The base table's column keys: what a flat input is split by (`splitByOwner`). */
const CRATE_BASE = parcels;
export const CRATE_BASE_KEYS: globalThis.ReadonlySet<string> = new Set(Object.keys(getTableColumns(CRATE_BASE)));

@Injectable()
export class CrateRepository extends BaseRepository<Crate, typeof crates, Relations> {
  readonly table = crates;

  constructor(
    @Inject(DRIZZLE) db: DrizzleClient<Relations>,
    // The pair write goes through the base's OWN repository, so its tenant stamp and timestamps apply (RFC-0006 §4.1).
    private readonly baseRepo: ParcelRepository,
  ) {
    super(db);
    // Every read runs on db.query.crates — fail HERE, naming the cause,
    // if the injected client was built without the relations manifest.
    this.requireRelationalQuery('crates');
    // findById / findByIds / list are defined below, so a pattern base class or
    // capability mixin overriding one of them would never run — throw, naming it.
    this.claimGeneratedReads(CrateRepository);
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
  // (`db.query.crates`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"crates" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CrateResult<W, C> | null> {
    const row = await this.db.query.crates.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
    });
    return (row as CrateResult<W, C> | undefined) ?? null;
  }

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async findByIds<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CrateResult<W, C>>> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.crates.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,
      with: opts?.with,
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<CrateResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async list<W extends CrateInclude = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    query?: ListOptions<typeof crates> & ReadOptions<W, C>,
  ): Promise<Array<CrateResult<W, C>>> {
    const sort = query?.sort;
    const rows = await this.db.query.crates.findMany({
      where: { RAW: this.rootFilter(query?.where) },
      columns: this.checkColumns<C>(query?.columns),
      with: query?.with,
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows as Array<CrateResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async count(where?: RowFilter<typeof crates>): Promise<number> {
    return super.count(where);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The base row (RFC-0006 §3.2, #875) — a crate IS a kind of a parcel
  //
  // `findWithBase` is `findById` with the base joined in and its columns hoisted
  // to the root: it CALLS `findById` / `findByIds`, so ONE statement (a primary-key
  // lateral join) and the one scope body — `columns` / `with` still apply to this table.
  // ═══════════════════════════════════════════════════════════════════════

  async findWithBase<W extends CrateInclude & { parcel?: never } = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CrateFlat<W, C> | null> {
    const row = await this.findById(id, { ...opts, with: { ...opts?.with, parcel: true as const } } as never);
    return row ? (flattenBase(row as never, 'parcel') as CrateFlat<W, C>) : null;
  }

  /** One statement for many ids, flat — it IS `findByIds` (no statement for `[]`, input order, absent when out of scope), with the base joined in. */
  async findManyWithBase<W extends CrateInclude & { parcel?: never } = CrateNoInclude, C extends CrateColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CrateFlat<W, C>>> {
    const rows = await this.findByIds(ids, { ...opts, with: { ...opts?.with, parcel: true as const } } as never);
    return rows.map((row) => flattenBase(row as never, 'parcel')) as Array<CrateFlat<W, C>>;
  }

  /**
   * This kind's rows, flat, filtered and sorted on the BASE's columns (RFC-0006 §3.3): the base's `listKind`, which
   * is what a child's HTTP list reads — its default sort is `created_at desc, id desc`, and `created_at` is the base's.
   * `opts.with` names this table's own relations; they are joined in the same statement.
   */
  async listFlat<W extends CrateInclude = CrateNoInclude>(
    query?: ListOptions<typeof parcels>,
    opts?: { with?: W },
  ): Promise<Array<CrateFlat<W>>> {
    return this.baseRepo.listKind('crate', query, opts?.with) as unknown as Array<CrateFlat<W>>;
  }

  /** How many rows `listFlat` ranges over, on the same scope: the base's `countKind`. */
  async countFlat(where?: RowFilter<typeof parcels>): Promise<number> {
    return this.baseRepo.countKind('crate', where);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The pair write (RFC-0006 §4.1, #875)
  //
  // A crate is two rows sharing one id: the base's and this table's. `create`, `update` and `delete`
  // OVERRIDE the inherited ones, on purpose — the inherited `create` would insert a row here with no
  // base row. The base half goes through the base's own repository (its tenant stamp, timestamps and
  // soft-delete apply), both halves in ONE transaction: the caller's when a `tx` is passed, else one opened here.
  // ═══════════════════════════════════════════════════════════════════════

  /** The kind this child writes is fixed ('crate'); an input that names another is refused. */
  private assertOwnKind(baseSlice: globalThis.Record<string, unknown>): void {
    const named = baseSlice['kind'];
    if (named !== undefined && named !== 'crate') {
      throw new KindMismatchError('crate', 'crate', `the input names kind '${String(named)}'`);
    }
  }

  /** Both rows, in one transaction; a failing child insert rolls the base row back. */
  override async create(input: CrateCreate, tx?: DrizzleTx): Promise<CrateFlat> {
    const { base, own } = splitByOwner(input, CRATE_BASE_KEYS);
    this.assertOwnKind(base);
    return inTransaction(this.db, tx, async (txClient) => {
      const baseRow = await this.baseRepo.create({ ...base, kind: 'crate' }, txClient, PAIR_WRITE);
      const [childRow] = await this.runner(txClient)
        .insert(this.table)
        .values(this.childValues({ ...own, id: baseRow.id }))
        .returning();
      return this.flat(childRow, baseRow);
    });
  }

  /** A write's values for this table, with its derived `match:` columns filled (typed as the table's insert). */
  private childValues(values: globalThis.Record<string, unknown>): typeof this.table.$inferInsert {
    return this.deriveColumns(values, 'create') as typeof this.table.$inferInsert;
  }

  /** The flat row of a written pair: the one owner of flattening is `flattenBase`. */
  private flat(childRow: Crate | undefined, baseRow: Parcel): CrateFlat {
    return flattenBase({ ...childRow, parcel: baseRow } as Crate & { parcel: Parcel }, 'parcel') as CrateFlat;
  }

  /**
   * Update across both tables. A `kind` key throws `KindImmutableError`. The child row is
   * found first (scoped), so a row of another kind is never touched through this repository; then the base is
   * updated — its guards (tenant, a derived column) run BEFORE anything of this table's is written, so a guard error
   * a caller swallows in its own transaction leaves nothing half written; then this table's row.
   * The base update runs whenever it has something to write.
   * Returns `undefined` (as `BaseRepository.update` does) when no such row is in scope.
   */
  override async update(id: string, patch: CrateUpdate, tx?: DrizzleTx): Promise<CrateFlat> {
    if ((patch as globalThis.Record<string, unknown>)['kind'] !== undefined) {
      throw new KindImmutableError('crate');
    }
    this.assertTenantWritable('update');
    const { base, own } = splitByOwner(patch, CRATE_BASE_KEYS);
    return inTransaction(this.db, tx, async (txClient) => {
      const [existing] = await this.runner(txClient)
        .select()
        .from(this.table)
        .where(this.scopeAnd(eq(this.col('id'), id)));
      if (existing === undefined) return undefined as unknown as CrateFlat;
      const baseRow =
        Object.keys(base).length > 0
          ? await this.baseRepo.update(id, base, txClient)
          : (await this.runner(txClient).select().from(CRATE_BASE).where(eq(CRATE_BASE.id, id)))[0];
      if (Object.keys(own).length === 0) return this.flat(existing, baseRow as Parcel);
      const [childRow] = await this.runner(txClient)
        .update(this.table)
        .set(this.deriveColumns(own, 'update'))
        .where(this.scopeAnd(eq(this.col('id'), id)))
        .returning();
      return this.flat(childRow, baseRow as Parcel);
    });
  }

  /**
   * Delete the pair by deleting the base row (RFC-0006 §4.1): hard — the FK cascade removes this row; soft — the
   * base's `deleted_at` is set and this row leaves scope through the `EXISTS`. A no-op for an id that is not
   * a crate in scope, so a row of another kind is never deleted through this repository.
   */
  override async delete(id: string, tx?: DrizzleTx): Promise<void> {
    return inTransaction(this.db, tx, async (txClient) => {
      const own = await this.runner(txClient)
        .select({ id: this.col('id') })
        .from(this.tableRef)
        .where(this.scopeAnd(eq(this.col('id'), id)));
      if (own[0] === undefined) return;
      await this.baseRepo.delete(id, txClient);
    });
  }


  // Inherited from BaseRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
}
