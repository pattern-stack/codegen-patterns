
import { Injectable, Inject } from '@nestjs/common';

import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient, DrizzleTx } from '@shared/types/drizzle';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '../../generated/relations';
import { IntegratedEntityRepository } from '@shared/base-classes/integrated-entity-repository';
import type { IntegrationUpsertConfig } from '@shared/base-classes/integration-upsert-config';
import type { BehaviorConfig, ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';
import { FieldValueService } from '../field-values/field-value.service';
import { leads, type Lead } from './lead.entity';

/**
 * Canonical fields a integrated lead write carries (#374). Copy-through
 * columns are typed from the entity; each FK is named by its parent's external
 * id and resolved as configured. Provider/providerMetadata are persistence
 * seam, not carried here.
 */
export interface LeadIntegrationWrite {
  readonly externalId: string;
  readonly name: string;
  /** Flat custom-field bag (EAV). */
  readonly fields?: globalThis.Record<string, unknown>;
}

/**
 * Canonical-projected view of a lead row, keyed for the integration differ
 * (#374). external_id_tracking columns (provider/providerMetadata) are OMITTED;
 * externalId is kept.
 */
export interface LeadIntegrationProjection {
  readonly id: string;
  readonly externalId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The root column mask a lead read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type LeadColumns = ColumnsOf<'leads'>;

/**
 * The relation keys a lead read may include — the `with` surface of
 * `leads` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type LeadInclude = IncludeOf<'leads'>;

/** The default `TWith` — no include. */
export type LeadNoInclude = globalThis.Record<string, never>;

/**
 * The row a lead read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `LeadResult` alone is the plain row; `LeadResult<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `LeadResult<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type LeadResult<
  TWith extends LeadInclude = LeadNoInclude,
  TColumns extends LeadColumns | undefined = undefined,
> = ResultOf<'leads', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `LeadResult<LeadInclude>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type LeadApiResult = Lead &
  globalThis.Partial<LeadResult<LeadInclude>>;

@Injectable()
export class LeadRepository extends IntegratedEntityRepository<
  Lead,
  typeof leads,
  Relations,
  LeadIntegrationWrite,
  LeadIntegrationProjection
> {
  readonly table = leads;

  // Behaviors declared in YAML -> generated as config object
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
    tenantScoped: false,
  };

  // Inbound-integration write surface (#374). Drives the generic integrationUpsertOne /
  // findByExternalIdProjected / softDeleteByExternalId on the base. FK
  // resolvers carry LIVE Drizzle table handles ('self' → this.table).
  protected readonly integrationConfig: IntegrationUpsertConfig = {
    conflictTarget: ['provider', 'externalId'],
    writeColumns: ['name'],
    fkResolvers: [
    ],
    projectionColumns: ['id', 'externalId', 'name', 'createdAt', 'updatedAt'],
    eav: true,
    softDelete: false,
  };

  constructor(
    @Inject(DRIZZLE) db: DrizzleClient<Relations>,
    private readonly fieldValues: FieldValueService,
  ) {
    super(db);
    this.requireRelationalQuery('leads');
    this.claimGeneratedReads(LeadRepository);
  }

  /**
   * EAV dual-write override (#374 seam → #124 live path). Delegates to the
   * shared FieldValueService so the inbound-integration write joins the same tx.
   */
  protected override async writeCustomFields(
    db: DrizzleTx,
    entityId: string,
    userId: string,
    fields: globalThis.Record<string, unknown>,
  ): Promise<void> {
    await this.fieldValues.upsertFieldsTransactional('lead', entityId, userId, fields, db);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1, docs/specs/READ-1.md; REL-2 #587)
  //
  // Every read takes the same shape knobs — a root `columns` mask — inferred at the call site. The signatures live HERE,
  // not on the base: with `TRelations` and the table key as naked type
  // parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2 §2.1).
  //
  // ONE execution path for the read surface below — `findById`, `findByIds`,
  // `list` and every plain `queries:` / `belongs_to` finder run on RQBv2
  // (`db.query.leads`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"leads" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<C extends LeadColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<LeadResult<LeadNoInclude, C> | null> {
    const row = await this.db.query.leads.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      columns: this.checkColumns<C>(opts?.columns),
    });
    return (row as LeadResult<LeadNoInclude, C> | undefined) ?? null;
  }

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async findByIds<C extends LeadColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<LeadResult<LeadNoInclude, C>>> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.leads.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<LeadResult<LeadNoInclude, C>>;
  }

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async list<C extends LeadColumns | undefined = undefined>(
    query?: ListOptions<typeof leads> & ReadOptions<never, C>,
  ): Promise<Array<LeadResult<LeadNoInclude, C>>> {
    const sort = query?.sort;
    const rows = await this.db.query.leads.findMany({
      where: { RAW: this.rootFilter(query?.where) },
      columns: this.checkColumns<C>(query?.columns),
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows as Array<LeadResult<LeadNoInclude, C>>;
  }

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async count(where?: RowFilter<typeof leads>): Promise<number> {
    return super.count(where);
  }

  // Inherited from IntegratedEntityRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
  //   findByExternalId, findManyByExternalIds
  //   integrationUpsertOne, findByExternalIdProjected, softDeleteByExternalId, integrationUpsert
}
