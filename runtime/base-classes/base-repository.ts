/**
 * BaseRepository<TEntity, TTable, TRelations>
 *
 * Abstract base class providing standard CRUD operations via Drizzle ORM.
 * Every generated repository extends this class.
 *
 * Family-specific bases (CrmEntityRepository, etc.) extend this in v0.1
 * without any changes to BaseRepository.
 *
 * NOT @Injectable — concrete repositories are @Injectable and inject DRIZZLE.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AnyPgSelectQueryBuilder,
  PgColumn,
  PgSelectKind,
  PgTable,
} from 'drizzle-orm/pg-core';
import type { AnyRelations, InferSelectModel, SQL } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTx } from '../types/drizzle';
import { column } from './table-columns';
import { assertGeneratedReadsOwned } from './read-surface';
import {
  scopeFilter,
  tenantAxisPredicate,
  tenantPredicateFor,
  userScopePredicateFor,
  type ScopeConfig,
  type TenantAxis,
} from './scope-filters';
import {
  CrossTenantWriteError,
  MissingTenantIdError,
  getTenantId,
  tryGetRequester,
} from './tenant-context';

// REL-2 (#587) moved these two out of this file and into the modules that own
// them — `column()` to `./table-columns` and the tenant predicate to
// `./scope-filters`, which needs both and which this file imports (a cycle
// otherwise). Re-exported here because that is where every existing caller
// reaches for them, and one definition with two import paths is not two
// definitions.
export { column, hasColumn } from './table-columns';
export { tenantPredicateFor } from './scope-filters';

/**
 * Render a tenant value for an error message. `null` is a real partition, not
 * an absence, so it must not print as "none" — the two mean different things
 * and an operator reading the error needs to tell them apart.
 */
function describeTenant(value: unknown): string {
  if (value === null) return 'the null-tenant partition';
  if (value === undefined) return 'no tenant';
  return `'${String(value)}'`;
}

/** The Postgres integer types an `id` may have — `idKey` compares them as integers. */
const INTEGER_KEY_TYPES: ReadonlySet<string> = new Set([
  'smallint',
  'integer',
  'bigint',
  'smallserial',
  'serial',
  'bigserial',
]);

// ============================================================================
// Typed reads
// ============================================================================

/**
 * A `$dynamic()` Drizzle SELECT builder with its row type replaced by `TRow`.
 *
 * `PgSelectDynamic<T>` is `PgSelectKind<…, T['_']['result'], …>`
 * (`pg-core/query-builders/select.types.d.ts`), so substituting the result slot
 * retypes the builder while every chained `.where()` / `.orderBy()` / `.limit()`
 * keeps working. `baseQuery()` needs this because the statement builders are
 * fed the WIDENED table (see `BaseRepository.tableRef`), whose rows are an
 * index signature; the rows actually selected are the concrete table's select
 * model. See `docs/specs/REL-0.md` §M2/§M4.
 */
export type RowsOf<Q extends AnyPgSelectQueryBuilder, TRow> = PgSelectKind<
  Q['_']['hkt'],
  Q['_']['tableName'],
  Q['_']['selection'],
  Q['_']['selectMode'],
  Q['_']['nullabilityMap'],
  true,
  never,
  TRow[],
  Q['_']['selectedFields']
>;

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Behavior flags for the repository. Controls automatic timestamp injection,
 * soft-delete filtering, and the two ambient scope axes.
 *
 * Every field is REQUIRED. `tenantScoped` is not optional-with-a-default
 * precisely because a silent `false` is the failure mode it guards against:
 * a repository that forgot to state its posture would read every tenant.
 * Stating it is one line per literal, and the compiler asks for it.
 *
 * `tenantScoped: true` REQUIRES `tenantColumn` (the column's property key,
 * `'tenantId'` / `'organizationId'`): {@link TenantAxis} is a union, so a
 * literal that says scoped and omits the column does not compile (#791).
 */
export type BehaviorConfig = TenantAxis & {
  timestamps: boolean;
  softDelete: boolean;
  userTracking: boolean;
};

/** One ordering term, as a COLUMN KEY rather than a rendered expression. */
export interface SortTerm {
  /** camelCase column key on this entity's table. */
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * A row predicate as a FUNCTION of the table handle (READ-1 §4, #840).
 *
 * Never a pre-rendered `SQL`: a generated read executes on the relational query
 * builder, which ALIASES the root (`"accounts" as "d0"`), so an expression built
 * against the real table names a FROM-clause entry that is not in scope and
 * Postgres rejects the statement. A function is handed whichever handle the
 * executing path holds — the alias there, this repository's own table on the
 * core builder — so one value is right on both.
 *
 * `undefined` means "no predicate".
 */
export type RowFilter<TTable extends PgTable> = (table: TTable) => SQL | undefined;

/**
 * Options for `list()` — the many-row read. Generic over the table, with no
 * default: a `where` written against the wrong table must not compile.
 *
 * There is deliberately no pre-rendered `where: SQL` and no `orderBy: SQL`
 * (READ-1 §4, charter I7): both rendered against the real table name and failed
 * on the aliased path (REL-2 §10 Found #2 / #9, #840).
 */
export interface ListOptions<TTable extends PgTable> {
  where?: RowFilter<TTable>;
  /**
   * The ordering as column KEYS + directions, rendered against whichever table
   * handle the executing path holds. One description, two renderings.
   */
  sort?: readonly SortTerm[];
  limit?: number;
  offset?: number;
}

/**
 * Rejects an EMPTY column mask at compile time (READ-1 §2.4). `columns: {}`
 * selects nothing at runtime and types as an empty row, which is never what a
 * caller meant; the runtime throws too (`BaseRepository.checkColumns`).
 */
export type NonEmptyMask<C> = C extends undefined
  ? unknown
  : keyof C extends never
    ? { readonly 'a columns mask must name at least one column': never }
    : unknown;

/**
 * The shape knobs every generated read takes (READ-1 §2.3): a `with` include
 * tree and a root `columns` mask. Both are inferred AT THE CALL SITE by the
 * generated method's own type parameters — the base cannot type them (REL-2
 * §2.1, TS2536) and only names the slots. `W` first, `C` second: the order
 * `<Entity>Result<W, C>` takes, everywhere.
 */
export interface ReadOptions<W, C> {
  columns?: C & NonEmptyMask<C>;
  with?: W;
}

// ============================================================================
// BaseRepository
// ============================================================================

export abstract class BaseRepository<
  TEntity,
  TTable extends PgTable,
  TRelations extends AnyRelations,
> {
  /**
   * The Drizzle table schema for this entity, at its CONCRETE type.
   * Concrete repositories declare this as a class property; generated ones
   * pass `typeof <tablePlural>` as `TTable` and initialise it with the table
   * itself, so `this.table['someColumn']` is checked in generated code and the
   * relation graph (REL-2) has a real type to hang a typed `with` include on.
   */
  protected abstract readonly table: TTable;

  /**
   * This repository's table widened to the non-generic `PgTable` that the
   * Drizzle statement builders can resolve.
   *
   * Measured on 1.0.0-rc.4 (`docs/specs/REL-0.md` §M1/§M2): a NAKED type
   * parameter defers every builder conditional — `TableLikeHasEmptySelection<T>`
   * on `.from()` and `TReturning extends undefined ? … : TReturning[]` on
   * `.returning()` — so `select().from(this.table)` and
   * `insert(this.table).…returning()` do not type-check inside this class. The
   * same expressions resolve completely for a value of declared type `PgTable`.
   *
   * This is a plain widening assignment, NOT an assertion: `PgTable` is
   * declared covariant (`PgTable<out T extends TableConfig>`) and a concrete
   * `pgTable(...)` is assignable to it. (`PgTableWithColumns<TableConfig>` is
   * NOT — that is what DRZ-2 measured and why the in-place narrowing failed.)
   *
   * Every statement in this class and the family bases goes through here; the
   * concrete `this.table` is what subclasses read.
   */
  protected get tableRef(): PgTable {
    return this.table;
  }

  /**
   * Behavior flags controlling automatic behavior injection.
   * Override in concrete repositories to enable behaviors.
   */
  protected readonly behaviors: BehaviorConfig = {
    timestamps: false,
    softDelete: false,
    userTracking: false,
    tenantScoped: false,
  };

  /**
   * Ambient scope enforcement, governing BOTH axes — `userTracking` (see
   * `scopePredicate`) and `tenantScoped` (see `tenantPredicate`). It has effect
   * only for the axes the repo actually declares.
   *
   * - `'lenient'` (default): when no ambient requester context is active,
   *   reads/writes are NOT scoped — preserves pre-scoping behavior, so adopting
   *   ambient scoping is additive. Scoping kicks in automatically once a
   *   boundary installs `withRequester(...)`.
   * - `'strict'`: a missing ambient context throws (`requireRequester`), and a
   *   context that carries no `tenantId` throws `MissingTenantIdError`, so a
   *   forgotten boundary fails loud instead of silently returning the union of
   *   every tenant.
   *
   * A `tenant_scoped: true` entity is EMITTED strict, with no opt-down
   * (ADR-042's 2026-09-20 revision note; charter I3 — "a missing context
   * throws; it never reads unscoped"). One knob over one context governs both
   * axes deliberately: a missing boundary is a missing boundary, whichever
   * filter it was meant to supply.
   */
  protected readonly scopeEnforcement: 'lenient' | 'strict' = 'lenient';

  /**
   * The Drizzle client, bound to THIS project's relation graph.
   *
   * `TRelations` is the generated `defineRelations()` manifest's type (REL-1),
   * which is what makes `this.db.query.<table>.findFirst({ with: … })` resolve in
   * a generated subclass. Third type parameter, NO default: `EmptyRelations`
   * would let a repository that forgot to pass its manifest compile and then
   * silently accept no includes (REL-2 §2.2, charter I7).
   *
   * The base cannot type the include itself — with `TRelations` and the relation
   * key as naked type parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2
   * §2.1). So the base carries the handle; the generated subclass carries the
   * signature.
   */
  protected readonly db: DrizzleClient<TRelations>;

  constructor(db: DrizzleClient<TRelations>) {
    this.db = db;
  }

  /**
   * Fail at CONSTRUCTION when the injected client was built without this
   * project's relations manifest (READ-1 review #8a). Every generated read runs
   * on `db.query.<key>`, which exists only on a client built with
   * `drizzle({ client, relations })`; without it, every read — not only an
   * include — would fail later as `undefined is not an object`. Called by the
   * generated constructor with its table's manifest key.
   */
  protected requireRelationalQuery(key: string): void {
    const query = (this.db as { query?: Record<string, unknown> }).query;
    if (query?.[key] === undefined) {
      throw new Error(
        `${this.constructor.name}: the injected Drizzle client has no relational query for '${key}'. ` +
          'Generated reads run on db.query.<table>, so the client bound to DRIZZLE must be built with ' +
          "this project's manifest: drizzle({ client, relations }) with `relations` from the generated relations.ts.",
      );
    }
  }

  /**
   * Fail at CONSTRUCTION when a class between this base and the generated
   * repository `owner` — a pattern base class, a capability mixin — overrides
   * `findById` / `findByIds` / `list`. The generated class defines those itself
   * (its typed `columns` / `with` signatures cannot live here, REL-2 §2.1), so
   * such an override would never run; this makes that loud instead of silent
   * (READ-1 §3.4). Called by the generated constructor with its own class. A
   * subclass of `owner` is not checked — its override runs.
   */
  protected claimGeneratedReads(owner: abstract new (...args: never[]) => unknown): void {
    assertGeneratedReadsOwned(
      owner,
      BaseRepository,
      'To narrow which rows EVERY read sees, override `scopeAndOn` (the one root-predicate assembly every read and ' +
        '`count` use); to wrap a read, give the wrapper its own name or override it on a subclass of the generated class.',
    );
  }

  /**
   * Pick the runner for a write: the caller-supplied transaction handle
   * if present, otherwise the repository's own client. Keeps the `tx`
   * parameter purely additive — callers without a transaction call as
   * before. Used by the write methods below + consumer overrides (e.g.
   * the generated `upsertCurrentValues` on EAV value tables).
   */
  protected runner(tx?: DrizzleTx): DrizzleClient {
    return tx ?? this.db;
  }

  /**
   * Resolve one of this table's columns by its camelCase key. Throws (naming
   * the repository) when the table has no such column — see `column()`.
   */
  protected col(name: string): PgColumn {
    return column(this.tableRef, name, this.constructor.name);
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Find a single entity by its primary key.
   * Returns null if not found (or soft-deleted when softDelete=true).
   */
  async findById(id: string): Promise<TEntity | null> {
    const rows = await this.baseQuery(eq(this.col('id'), id)).limit(1);
    return (rows[0] as TEntity) ?? null;
  }

  /**
   * Find entities by their primary keys — READ-1 §2.4's semantics, which the
   * generated override keeps on its relational path:
   *
   *   - `[]` returns `[]` and issues no statement — after the scope's boundary
   *     checks, so under `strict` a missing context throws on `[]` too;
   *   - duplicate ids are read once and returned once;
   *   - rows come back in INPUT order (first occurrence) — `in (…)` does not
   *     preserve it, so the rows are re-sorted here;
   *   - a missing, soft-deleted or out-of-scope id is simply absent (no
   *     existence oracle; no `null` placeholders).
   *
   * One `in ($1…$n)`: Postgres caps a statement at 65 535 parameters, and the
   * list is not chunked — chunking would silently become several statements.
   */
  async findByIds(ids: readonly string[]): Promise<TEntity[]> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      this.assertReadScope();
      return [];
    }
    const rows = await this.baseQuery(inArray(this.col('id'), unique));
    return this.inInputOrder(rows, unique, false) as TEntity[];
  }

  /**
   * List entities with optional filtering, pagination, and ordering.
   * `where` is a {@link RowFilter} — handed this repository's own table here.
   */
  async list(options?: ListOptions<TTable>): Promise<TEntity[]> {
    let query = this.baseQuery(options?.where?.(this.table));

    const sorted = this.orderByOn(this.tableRef, options?.sort);
    if (sorted) {
      query = query.orderBy(...sorted) as typeof query;
    }
    if (options?.limit !== undefined) {
      query = query.limit(options.limit) as typeof query;
    }
    if (options?.offset !== undefined) {
      query = query.offset(options.offset) as typeof query;
    }

    const rows = await query;
    return rows as TEntity[];
  }

  /**
   * Count entities matching an optional {@link RowFilter} — the same value a
   * caller hands `list()`, so a page's rows and its total describe one set.
   * Soft-deleted rows are always excluded when softDelete=true.
   *
   * Routes the caller predicate through `scopeAnd()` — the SAME assembly
   * (`scopeAndOn`) `baseQuery()` and every generated read's `rootFilter` use —
   * rather than re-listing the guards here. It used to hand-assemble them, which
   * is how it silently drifted out of the choke point (SCOPE-0, #616); there is
   * now exactly one place a guard is added.
   */
  async count(where?: RowFilter<TTable>): Promise<number> {
    const query = this.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(this.tableRef)
      .$dynamic();

    const scoped = this.scopeAnd(where?.(this.table), {
      softDelete: this.behaviors.softDelete,
    });

    const rows = await (scoped ? query.where(scoped) : query);
    return rows[0]?.count ?? 0;
  }

  /**
   * Check whether an entity with the given id exists.
   */
  async exists(id: string): Promise<boolean> {
    const result = await this.findById(id);
    return result !== null;
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Insert a new entity. Timestamps are auto-injected when timestamps=true;
   * the tenant column is stamped from the ambient tenant when tenantScoped=true.
   */
  async create(input: Partial<TEntity>, tx?: DrizzleTx): Promise<TEntity> {
    const data = this.stampTenant(
      this.withTimestamps(input as Record<string, unknown>, 'create'),
    );
    const rows = await this.runner(tx)
      .insert(this.tableRef)
      .values(data)
      .returning();
    return rows[0] as TEntity;
  }

  /**
   * Update an existing entity by id. updatedAt is auto-injected when
   * timestamps=true. On a tenant-scoped repository the SET payload may not
   * re-parent the row (`guardTenantOnUpdate`), and the call is refused inside
   * `withAllTenants()` (`assertTenantWritable`).
   * Returns the updated entity.
   */
  async update(id: string, input: Partial<TEntity>, tx?: DrizzleTx): Promise<TEntity> {
    this.assertTenantWritable('update');
    const data = this.guardTenantOnUpdate(
      this.withTimestamps(input as Record<string, unknown>, 'update'),
    );
    const rows = await this.runner(tx)
      .update(this.tableRef)
      .set(data)
      .where(this.scopeAnd(eq(this.col('id'), id)))
      .returning();
    return rows[0] as TEntity;
  }

  /**
   * Delete an entity by id.
   * - softDelete=true: sets deletedAt to current timestamp
   * - softDelete=false: hard-deletes the row
   */
  async delete(id: string, tx?: DrizzleTx): Promise<void> {
    this.assertTenantWritable('delete');
    const runner = this.runner(tx);
    if (this.behaviors.softDelete) {
      await runner
        .update(this.tableRef)
        .set({ deletedAt: new Date() })
        .where(this.scopeAnd(eq(this.col('id'), id)));
    } else {
      await runner
        .delete(this.tableRef)
        .where(this.scopeAnd(eq(this.col('id'), id)));
    }
  }

  /**
   * Insert or update multiple entities.
   * Default naive implementation — family repositories override with
   * proper conflict-target upsert (e.g., CrmEntityRepository).
   *
   * This default delegates to `create()`, so it inherits the tenant stamp.
   * An override that builds its own `INSERT … ON CONFLICT` does NOT: the
   * conflict target must include the tenant column or tenant B's write will update
   * tenant A's row. See `IntegratedEntityRepository.integrationUpsertOne` and
   * `MetadataEntityRepository.upsertMany` for how each one rules on that.
   */
  async upsertMany(inputs: Array<Partial<TEntity>>, tx?: DrizzleTx): Promise<TEntity[]> {
    return Promise.all(inputs.map((input) => this.create(input, tx)));
  }

  // ============================================================================
  // Protected Helpers
  // ============================================================================

  /**
   * Base SELECT query that automatically applies the ambient guards —
   * soft-delete exclusion (when `softDelete`), the user-axis scope (when
   * `userTracking`) and the tenant-axis scope (when `tenantScoped`) —
   * combined with an optional caller `extra` predicate into a SINGLE `WHERE`.
   *
   * Pass the leaf predicate as `extra` rather than chaining a second
   * `.where(...)`: Drizzle's `.where()` OVERRIDES (does not AND) a prior
   * `.where()` on a `$dynamic()` query — `pg-core/query-builders/select.js`
   * is literally `this.config.where = where` — so a chained call silently
   * drops the soft-delete and scope guards. `baseQuery(extra)` is the ONLY
   * safe form.
   *
   * This is not advice: `this.baseQuery().where(...)` is a defect, 17 of them
   * shipped (SCOPE-0, #616), and `src/__tests__/templates/no-basequery-where.test.ts`
   * now fails the build on the shape anywhere under `templates/` or `runtime/`.
   */
  protected baseQuery(extra?: SQL) {
    const query = this.db.select().from(this.tableRef).$dynamic();
    const where = this.scopeAnd(extra, { softDelete: this.behaviors.softDelete });
    const scoped = where ? query.where(where) : query;
    // The builder was fed the WIDENED table (`tableRef`), so Drizzle types its
    // rows as an index signature; what it actually selects is this table's
    // select model. `RowsOf` restores that — which is also what keeps a
    // generated `rows as <Entity>[]` an identity assertion, since the emitted
    // entity type IS `InferSelectModel<typeof <table>>`.
    return scoped as RowsOf<typeof query, InferSelectModel<TTable>>;
  }

  /**
   * This repository's declared scope posture, as ONE value — the same shape the
   * emitted relations manifest carries for each hop (REL-2 §3). Both come from
   * the entity's YAML declaration, which is what keeps the root and the hops from
   * drifting apart (charter I1/I3).
   *
   * `softDelete` is per-CALL, not read from `behaviors`: the by-id write paths
   * (`update` / `delete`) must still match a soft-deleted row. Everything else is
   * a property of the entity.
   */
  protected scopeConfigFor(opts?: { softDelete?: boolean }): ScopeConfig {
    const rest = {
      softDelete: opts?.softDelete === true,
      userTracking: this.behaviors.userTracking,
      enforcement: this.scopeEnforcement,
    };
    return this.behaviors.tenantScoped
      ? { tenantScoped: true, tenantColumn: this.tenantColumn, ...rest }
      : { tenantScoped: false, ...rest };
  }

  /**
   * The ambient USER-axis predicate for this repo's table.
   *
   * Returns `undefined` (no scoping) when:
   *   - `behaviors.userTracking` is false (repo is not user-owned), or
   *   - no ambient requester context is active AND `scopeEnforcement` is
   *     `'lenient'` (the default — preserves pre-scoping behavior).
   *
   * When a requester context is active, scopes by `user_id` per the ambient
   * scope: `'user'` → `user_id = ctx.userId`; `'org'` → `user_id IN
   * ctx.orgUserIds` (empty list matches nothing — fail-closed); `'superuser'`
   * → no filter. An active context with no `userId` in `'user'` scope throws
   * `MissingUserIdError` under either enforcement (#853). See
   * `tenant-context.ts` for the boundary-install contract.
   *
   * One line, because REL-2 (#587) lifted the axis into `scope-filters.ts`: the
   * same function scopes every HOP of an include tree, and a second copy here is
   * exactly the drift that makes a nested read leak (charter I1/I3).
   */
  protected scopePredicate(): SQL | undefined {
    if (!this.behaviors.userTracking) return undefined;
    return userScopePredicateFor(
      this.tableRef,
      this.scopeEnforcement,
      this.constructor.name,
    );
  }

  /**
   * The ambient TENANT predicate for this repo's table (ADR-042).
   *
   * Returns `undefined` (no tenant filter) when:
   *   - `behaviors.tenantScoped` is false, or
   *   - `withAllTenants(...)` is in effect (deliberate cross-tenant read), or
   *   - `scopeEnforcement` is `'lenient'` and no tenant is established.
   *
   * Under `'strict'` — which is what a `tenant_scoped: true` entity is emitted
   * with — there is no third case: `getTenantId` throws rather than returning
   * `undefined`, so this either filters or raises. It never quietly reads across
   * tenants. Same lift as `scopePredicate` above.
   */
  protected tenantPredicate(): SQL | undefined {
    return tenantAxisPredicate(
      this.tableRef,
      this.scopeConfigFor(),
      this.constructor.name,
    );
  }

  /**
   * The ROOT filter of every generated read (READ-1 §3.2) — the caller's
   * {@link RowFilter} AND this repository's scope, as one `RAW` callback for the
   * relational query builder:
   *
   *   `where: { RAW: this.rootFilter((t) => inArray(t.id, ids)) }` — a keyed read
   *   `where: { RAW: this.rootFilter(query?.where) }`             — `list()`
   *
   * It is the read's WHOLE root `where`: one predicate, rendered on the alias.
   *
   * **Both halves render against the table RQBv2 hands the callback, never
   * `this.tableRef`.** The relational builder ALIASES the root
   * (`from "regions" as "d0"`), so a predicate built against this repository's
   * own handle — or a caller's pre-rendered SQL — renders
   * `"regions"."deleted_at"`: an invalid reference to a FROM-clause entry, and
   * the read fails (REL-2 §10 Found #9; #840 for the caller's `where`).
   *
   * The assembly is `scopeAndOn(table, …)` — the SAME one `scopeAnd()` uses on the
   * core builder — and its scope half is `scopeFilter`, which the manifest's
   * `hopScope` applies at every hop, so the root and the hops cannot disagree
   * (charter I3). Renders `true` when nothing applies, because a `RAW` slot
   * takes a `SQL`.
   *
   * Generic in its OWN table parameter, not the class's `TTable`: `T` is
   * inferred from the RQBv2 `RAW` slot the result is handed to (the concrete
   * aliased table), so `(t) => eq(t.id, id)` is typed even inside a capability
   * mixin, whose base sees `TTable` only as `PgTable` — and a class-typed
   * `(table: TTable) => SQL` return would put `TTable` in a contravariant
   * position and stop a concrete repository fitting `RepositoryCtor`.
   */
  protected rootFilter<T extends PgTable>(where?: RowFilter<T>): (table: T) => SQL {
    return (table: T) =>
      this.scopeAndOn(table, where?.(table), { softDelete: this.behaviors.softDelete }) ?? sql`true`;
  }

  /**
   * Refuse an EMPTY column mask (READ-1 §2.4). It selects no columns at runtime
   * and types as an empty row — never what a caller meant. `NonEmptyMask`
   * rejects the literal `{}` at compile time; this catches a mask built at
   * runtime.
   *
   * "Empty" is judged AFTER dropping `undefined`-valued keys: Drizzle ignores
   * them, so `{ name: undefined }` selects exactly what `{}` does — nothing at
   * the root, and with a `with` a row of relations only. Those keys are dropped
   * from the mask that is sent, and a mask left with no key throws.
   *
   * Returns the mask typed as plain `C` — WITHOUT the `NonEmptyMask` brand — so
   * the query config Drizzle infers its result from carries `columns: C`, the
   * same `C` the generated `<Entity>Result<W, C>` names. With the brand still on
   * it the two results are distinct deferred types, and on 1.0.0-rc.5 the
   * generated `rows as <Entity>Result<W, C>` is a TS2352 (measured).
   */
  protected checkColumns<C>(columns: (C & NonEmptyMask<C>) | undefined): C | undefined {
    if (columns === undefined || columns === null || typeof columns !== 'object') {
      return columns as C | undefined;
    }
    const defined = Object.entries(columns as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (defined.length === 0) {
      throw new Error(
        `${this.constructor.name}: an empty \`columns\` mask selects nothing — ` +
          'name at least one column (a key set to `undefined` names none), or omit `columns` for the whole row.',
      );
    }
    return Object.fromEntries(defined) as C;
  }

  /**
   * The key an id is compared by — the database's spelling, not the caller's.
   *
   * Postgres PARSES an `in (…)` operand into the key's type, so several caller
   * spellings name one row, and the row comes back in the canonical one.
   * Comparing the caller's raw string against that would silently drop the row
   * (READ-1 review #2, R-2). So both sides are canonicalised by the key's type:
   *   - `uuid` — `'A0EEBC99-…'`, `'{a0eebc99-…}'` and the unhyphenated form all
   *     become the lowercase hyphenated form;
   *   - an integer type — `'7'`, `'07'` and the driver's `7` all become `'7'`;
   *   - anything else (`text`, `varchar`, …) — its text, case kept, as Postgres
   *     compares it.
   * A spelling this does not canonicalise makes `inInputOrder` THROW, never drop.
   */
  protected idKey(id: unknown): unknown {
    if (id === null || id === undefined) return id;
    const type = this.col('id').getSQLType();
    if (type === 'uuid') {
      if (typeof id !== 'string') return id;
      const hex = id.replace(/[{}-]/g, '').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) return id;
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    if (INTEGER_KEY_TYPES.has(type)) {
      const text = String(id).trim();
      return /^[+-]?\d+$/.test(text) ? BigInt(text).toString() : text;
    }
    return String(id);
  }

  /**
   * De-duplicate an id list by {@link idKey}, keeping first-occurrence order —
   * so `'A0EE…'` and `'a0ee…'` are one id, read once.
   */
  protected uniqueIds(ids: readonly string[]): string[] {
    const seen = new Set<unknown>();
    const unique: string[] = [];
    for (const id of ids) {
      const key = this.idKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(id);
    }
    return unique;
  }

  /**
   * The column mask a by-ids read sends: the caller's, with `id` guaranteed
   * selected so the rows can be put back in input order. `stripId` says whether
   * the caller's mask omitted `id`, in which case `inInputOrder` removes it again
   * and the result is exactly what the caller's mask types it as.
   *
   *   - no mask, or a mask that already selects `id` → unchanged;
   *   - an INCLUSION mask (any `true`) without `id` → `id: true` added;
   *   - an EXCLUSION mask (only `false`s) that excludes `id` → that key dropped
   *     (adding `id: true` would turn it into a one-column inclusion mask) — and
   *     if `id` was the ONLY exclusion, no mask at all: an empty `{}` selects no
   *     root column, so Drizzle throws without a `with` and, with one, returns
   *     rows with no `id` to order by (READ-1 review #1).
   */
  protected byIdsColumns<C>(columns: C): { columns: C | undefined; stripId: boolean } {
    if (columns === undefined || columns === null || typeof columns !== 'object') {
      return { columns, stripId: false };
    }
    const mask = columns as Record<string, boolean | undefined>;
    if (mask['id'] === true) return { columns, stripId: false };
    const inclusion = Object.values(mask).some((v) => v === true);
    if (inclusion) {
      return { columns: { ...mask, id: true } as C, stripId: true };
    }
    if (mask['id'] === false) {
      const { id: _excluded, ...rest } = mask;
      return { columns: Object.keys(rest).length === 0 ? undefined : (rest as C), stripId: true };
    }
    return { columns, stripId: false };
  }

  /**
   * Put by-id rows back in the caller's order (first occurrence), dropping
   * nothing and inventing nothing: an id with no row is absent. With `stripId`,
   * removes the `id` key a mask that omitted it was given by `byIdsColumns`.
   *
   * A row WITHOUT an `id`, or one no input id claims, is a defect in the read,
   * not a missing row, so it THROWS rather than being silently dropped.
   */
  protected inInputOrder<TRow extends object>(
    rows: readonly TRow[],
    ids: readonly string[],
    stripId: boolean,
  ): TRow[] {
    const byId = new Map<unknown, TRow>();
    for (const row of rows) {
      const id = (row as Record<string, unknown>)['id'];
      if (id === undefined || id === null) {
        throw new Error(
          `${this.constructor.name}.findByIds: a row came back without an \`id\` — ` +
            'the statement must select it to order by it. This is a bug in the read, not a missing row.',
        );
      }
      byId.set(this.idKey(id), row);
    }
    const ordered: TRow[] = [];
    for (const id of ids) {
      const key = this.idKey(id);
      const row = byId.get(key);
      if (row === undefined) continue;
      byId.delete(key);
      if (stripId) delete (row as Record<string, unknown>)['id'];
      ordered.push(row);
    }
    // A row the database returned for this `in (…)` that no input id claims means
    // `idKey` spells this key differently from Postgres — the row was matched in
    // SQL and would be silently dropped here. Loud, not lossy.
    if (byId.size > 0) {
      throw new Error(
        `${this.constructor.name}.findByIds: ${byId.size} row(s) matched in SQL but no input id ` +
          `claims them (key type '${this.col('id').getSQLType()}') — idKey does not canonicalise ` +
          'this key the way Postgres does. This is a bug in the read, not a missing row.',
      );
    }
    return ordered;
  }

  /**
   * Render a {@link ListOptions.sort} against a SPECIFIC table handle.
   *
   * The handle matters: the relational query builder aliases the root table and
   * hands the alias to an `orderBy` callback, so an expression built against this
   * repository's own table would reference a name that is not in scope there.
   * Passing the table in is what lets one sort description serve both paths
   * (REL-2 §2.4).
   */
  protected orderByOn(
    table: PgTable,
    sort?: readonly SortTerm[],
  ): SQL[] | undefined {
    if (!sort || sort.length === 0) return undefined;
    return sort.map((term) => {
      const col = column(table, term.column, this.constructor.name);
      return (term.direction === 'asc' ? asc : desc)(col);
    });
  }

  /**
   * The tenant column's property key — `behaviors.tenantColumn` (#791). Every
   * tenant read and write in this class and the family bases goes through here,
   * never through a literal. Only meaningful when `behaviors.tenantScoped`;
   * asking an unscoped repository for it is a bug, so it throws.
   */
  protected get tenantColumn(): string {
    const b = this.behaviors;
    if (!b.tenantScoped) {
      throw new Error(
        `${this.constructor.name}: no tenant column — behaviors.tenantScoped is false.`,
      );
    }
    return b.tenantColumn;
  }

  /**
   * The tenant column resolved on this repository's table. Throws, naming the
   * repository, when the table has no such column — so a wrong `tenantColumn`
   * fails a WRITE as loudly as a read (Drizzle would otherwise drop an unknown
   * insert key and the row would land in the null-tenant partition).
   */
  protected tenantColumnRef(owner: string): PgColumn {
    return column(this.tableRef, this.tenantColumn, owner);
  }

  /**
   * Stamp the tenant column onto an insert from the ambient tenant. No-op
   * unless `behaviors.tenantScoped`.
   *
   * An explicitly-supplied tenant value does NOT win. The point of an ambient
   * scope is that ordinary request-scope code cannot name a tenant, and a
   * payload carrying its own tenant value is exactly code naming one — a DTO
   * field that slipped through, a spread of an untrusted body. `scopeAnd()`
   * guards which rows a statement can SEE; nothing but this guards what an
   * insert WRITES. So an explicit value is honoured only when it AGREES with
   * the ambient tenant, and otherwise throws `CrossTenantWriteError`.
   *
   * The two deliberate ways across the boundary both stay open:
   *   - `withTenantScope(tenantId, fn)` moves the ambient tenant, so the write
   *     agrees with it and is auditable at the call site;
   *   - `withAllTenants(fn)` drops the tenant entirely, and there an explicit
   *     tenant value is MANDATORY and may name any tenant — nothing else can
   *     supply one. Omitting it throws `MissingTenantIdError`.
   *
   * Named `stampTenant`, not `withTenant`, to leave `withTenantScope` (the ALS
   * hatch) unambiguous.
   */
  protected stampTenant(input: Record<string, unknown>): Record<string, unknown> {
    if (!this.behaviors.tenantScoped) return input;
    const owner = this.constructor.name;
    const key = this.tenantColumn;
    const dbColumn = this.tenantColumnRef(owner).name;
    const explicit = input[key];

    // Cross-tenant tooling: no ambient tenant to agree with, so the caller must
    // name the owner — and may name any of them.
    if (tryGetRequester()?.tenantScope === 'all') {
      if (explicit === undefined) throw new MissingTenantIdError(owner);
      return input;
    }

    // Resolved BEFORE the explicit check, so a strict repository still demands
    // a boundary even when the payload carries a tenant.
    const tenantId = getTenantId(this.scopeEnforcement, owner);

    if (explicit !== undefined) {
      // `tenantId === undefined` is lenient-with-no-tenant-established: nothing
      // is scoped in that mode, so there is no ambient value to disagree with
      // and the explicit one is the only source there is.
      if (tenantId !== undefined && explicit !== tenantId) {
        throw new CrossTenantWriteError(
          owner,
          `create() was given ${dbColumn} ${describeTenant(explicit)} while ` +
            `acting within ${describeTenant(tenantId)}`,
        );
      }
      return input;
    }

    return { ...input, [key]: tenantId ?? null };
  }

  /**
   * Reject a tenant-column value in an UPDATE payload that disagrees with the ambient
   * tenant. No-op unless `behaviors.tenantScoped`.
   *
   * `scopeAnd()` guards WHICH row an update touches; it says nothing about what
   * is written into it. Without this, a caller could re-parent their own row
   * into another tenant — `update(myRowId, { <tenantColumn>: other })` — which is a
   * cross-tenant write dressed as an ordinary edit, and one that leaves no
   * trace in the WHERE clause to notice.
   *
   * An agreeing value is allowed so that round-tripping a row keeps working.
   */
  protected guardTenantOnUpdate(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.behaviors.tenantScoped) return input;
    const owner = this.constructor.name;
    const key = this.tenantColumn;
    const dbColumn = this.tenantColumnRef(owner).name;
    const explicit = input[key];
    if (explicit === undefined) return input;

    const tenantId = getTenantId(this.scopeEnforcement, owner);
    if (tenantId !== undefined && explicit !== tenantId) {
      throw new CrossTenantWriteError(
        owner,
        `update() was given ${dbColumn} ${describeTenant(explicit)} while ` +
          `acting within ${describeTenant(tenantId)}`,
      );
    }
    return input;
  }

  /**
   * Refuse a by-id write while the tenant filter is deliberately dropped.
   *
   * Inside `withAllTenants(...)` the tenant predicate is gone, so
   * `scopeAnd(eq(id, …))` matches whichever tenant owns that id — the
   * statement's blast radius is every tenant at once. Reading across tenants is
   * a choice a caller can reasonably make; updating or deleting a row without
   * naming whose it is never is. `withTenantScope(tenantId, fn)` is the way to
   * do it deliberately, and it keeps working.
   *
   * Inserts are handled separately, by `stampTenant()` — there the caller CAN
   * name the owner, and must.
   */
  protected assertTenantWritable(operation: string): void {
    if (!this.behaviors.tenantScoped) return;
    if (tryGetRequester()?.tenantScope !== 'all') return;
    throw new CrossTenantWriteError(
      this.constructor.name,
      `${operation} by id is not available inside withAllTenants() — with the ` +
        'tenant filter dropped it would match whichever tenant owns that id',
    );
  }

  /**
   * Combine every ambient guard — soft-delete, the user-axis scope, the
   * tenant-axis scope — with a caller `extra` predicate into one `SQL`, rendered
   * against `table`. Returns `undefined` when nothing applies.
   *
   * This is the ONLY place a guard is added. Its two callers differ only in the
   * handle: {@link scopeAnd} passes this repository's own table (the core
   * builder — `baseQuery()`, `count()`, `update()`, `delete()`), and
   * {@link rootFilter} passes the aliased root RQBv2 hands its `RAW` callback
   * (every generated read).
   */
  protected scopeAndOn(
    table: PgTable,
    extra: SQL | undefined,
    opts?: { softDelete?: boolean },
  ): SQL | undefined {
    const scope = scopeFilter(table, this.scopeConfigFor(opts), this.constructor.name);
    if (!scope) return extra;
    if (!extra) return scope;
    return and(scope, extra);
  }

  /** {@link scopeAndOn} on this repository's own table — the core builder's form. */
  protected scopeAnd(
    extra?: SQL,
    opts?: { softDelete?: boolean },
  ): SQL | undefined {
    return this.scopeAndOn(this.tableRef, extra, opts);
  }

  /**
   * Run the scope's boundary checks without building a statement: under
   * `strict`, a missing requester / tenant throws here exactly as it would on a
   * read. For a read that short-circuits before issuing one (`findByIds([])`), so
   * a forgotten boundary fails the same way whatever the input.
   */
  protected assertReadScope(): void {
    this.scopeAnd(undefined, { softDelete: this.behaviors.softDelete });
  }

  /**
   * Merge timestamp fields into an input object.
   * - mode='create': adds createdAt and updatedAt
   * - mode='update': adds updatedAt only
   *
   * No-op when timestamps behavior is disabled.
   */
  protected withTimestamps(
    input: Record<string, unknown>,
    mode: 'create' | 'update',
  ): Record<string, unknown> {
    if (!this.behaviors.timestamps) return input;
    const now = new Date();
    if (mode === 'create') {
      return { ...input, createdAt: now, updatedAt: now };
    }
    return { ...input, updatedAt: now };
  }

  /**
   * A {@link RowFilter}: "this row's parent (by a `belongs_to` FK) is not
   * soft-deleted".
   *
   * Use this in custom repository methods when you need "rows reachable
   * from an active parent". The default findAll / findById behavior is
   * NOT changed by this helper — opt in explicitly where needed.
   *
   * ADR-021 — Soft-delete cascade: Option A (filter at query time).
   * `on_delete` FK rules do not fire for soft-deletes; use this helper
   * instead of expecting cascade semantics on the DB level.
   *
   * The `EXISTS` correlates on the FK of the handle it is GIVEN — the aliased
   * root on a generated read — never on this repository's own table, which the
   * relational builder aliased away (READ-1 §4; the FROM-clause class of #840).
   *
   * Example:
   *   async listActiveMessages(): Promise<Message[]> {
   *     return this.list({ where: this.activeParentFilter(conversations, 'conversationId') });
   *   }
   *
   * @param parentTable  The Drizzle table object for the parent entity.
   * @param fkKey  camelCase key of the FK column on this (child) table that references parent.id.
   */
  protected activeParentFilter(
    parentTable: PgTable,
    fkKey: string,
  ): (table: PgTable) => SQL {
    const owner = this.constructor.name;
    return (table: PgTable) => sql`EXISTS (
      SELECT 1 FROM ${parentTable} p
      WHERE p.id = ${column(table, fkKey, owner)}
        AND p.deleted_at IS NULL
    )`;
  }
}
