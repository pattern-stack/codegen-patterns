
import { Injectable, Inject } from '@nestjs/common';

import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '../../generated/relations';
import { ActivityEntityRepository } from '@shared/base-classes/activity-entity-repository';
import { WithCommunication } from '@shared/base-classes/with-communication';
import type { BehaviorConfig, ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import { calls, type Call } from './call.entity';

/**
 * The root column mask a call read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type CallColumns = ColumnsOf<'calls'>;

/**
 * The relation keys a call read may include — the `with` surface of
 * `calls` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type CallInclude = IncludeOf<'calls'>;

/** The default `TWith` — no include. */
export type CallNoInclude = globalThis.Record<string, never>;

/**
 * The row a call read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `CallResult` alone is the plain row; `CallResult<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `CallResult<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type CallResult<
  TWith extends CallInclude = CallNoInclude,
  TColumns extends CallColumns | undefined = undefined,
> = ResultOf<'calls', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `CallResult<CallInclude>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type CallApiResult = Call &
  globalThis.Partial<CallResult<CallInclude>>;

@Injectable()
export class CallRepository extends WithCommunication(ActivityEntityRepository<Call, typeof calls, Relations>) {
  readonly table = calls;

  // Behaviors declared in YAML -> generated as config object
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
    tenantScoped: false,
  };

  // Per-entity `Communication` capability config (from the entity YAML).
  // The capability's mixin declares `communicationConfig`; this concrete
  // record fills it — ADR-041 §6's config hand-off for a layered capability.
  // Public: a runtime-shipped mixin declares it public (declaration emit,
  // ADR-041.1), and a public override also fills a protected declaration.
  override readonly communicationConfig = {
    roles: {
      caller: {
        cardinality: 'one',
        target: 'contact',
        column: 'callerId',
      },
      regarding: {
        cardinality: 'one',
        target: 'account',
        column: 'regardingAccountId',
      },
    },
  } as const;

  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
    // Every read runs on db.query.calls — fail HERE, naming the cause,
    // if the injected client was built without the relations manifest.
    this.requireRelationalQuery('calls');
    // findById / findByIds / list are defined below, so a pattern base class or
    // capability mixin overriding one of them would never run — throw, naming it.
    this.claimGeneratedReads(CallRepository);
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
  // (`db.query.calls`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"calls" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CallResult<W, C> | null> {
    const row = await this.db.query.calls.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
    });
    return (row as CallResult<W, C> | undefined) ?? null;
  }

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async findByIds<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.calls.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,
      with: opts?.with,
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<CallResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async list<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    query?: ListOptions<typeof calls> & ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    const sort = query?.sort;
    const rows = await this.db.query.calls.findMany({
      where: { RAW: this.rootFilter(query?.where) },
      columns: this.checkColumns<C>(query?.columns),
      with: query?.with,
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows as Array<CallResult<W, C>>;
  }

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async count(where?: RowFilter<typeof calls>): Promise<number> {
    return super.count(where);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FK traversal methods (from belongs_to relationships — CGP-358b)
  // Called by service-layer composition methods on the inverse (has_many) side.
  // A FK method whose name collides with a unique/via/select declarative query
  // is skipped — that declarative query is the more specific intent and wins.
  // ═══════════════════════════════════════════════════════════════════════

  async findByAccountId<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    id: string,
    opts?: { limit?: number } & ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    const rows = await this.db.query.calls.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.accountId, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Array<CallResult<W, C>>;
  }

  async findByCallerId<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    id: string,
    opts?: { limit?: number } & ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    const rows = await this.db.query.calls.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.callerId, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Array<CallResult<W, C>>;
  }

  async findByRegardingAccountId<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    id: string,
    opts?: { limit?: number } & ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    const rows = await this.db.query.calls.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.regardingAccountId, id)) },
      columns: this.checkColumns<C>(opts?.columns),
      with: opts?.with,
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Array<CallResult<W, C>>;
  }

  // Inherited from ActivityEntityRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
  //   findByDateRange, findByUserId, findBySubjectId, findRecentBySubjectId
}
