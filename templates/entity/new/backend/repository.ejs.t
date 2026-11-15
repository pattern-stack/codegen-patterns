---
to: "<%= outputPaths.repository %>"
force: true
---
<%- generatedBanner %>
import { Injectable, Inject } from '@nestjs/common';
<%_
// ADR-046 — this template PRINTS the repository's methods. Which methods exist,
// what each is called and its parameter names come from `apiSurface`
// (`src/derived/api/`), including the `queries:` × `belongs_to` precedence (a
// plain finder and an FK finder resolving to one name emit once). The TS text
// beside them comes from `queryTypes`, keyed by the derived name (PLAN §4.3).
const _methods = apiSurface.repository.methods.filter((m) => m.emitted);
// READ-1: a plain ordered finder now orders through RQBv2's `orderBy` object, so
// `asc`/`desc` are needed only by an ordered `via:` / `select:` finder.
const _needsOrderFns = _methods.some((m) => m.kind === 'finder_projection' && queryTypes[m.name].order);
const _firstFkFinder = _methods.find((m) => m.kind === 'fk_finder');
const E = classNames.entity;
// READ-1 §2.3 — the generic parameters, options and result of every shaped read.
// `with` exists only where REL-2 §2.5 allows it; `columns` everywhere.
// `with` first, `columns` second — everywhere, the order `<Entity>Result` takes,
// so REL-2's `<Entity>Result<W>` keeps its meaning.
const _typedInclude = apiSurface.repository.typedInclude;
const _readGenerics = _typedInclude
  ? `<W extends ${E}Include = ${E}NoInclude, C extends ${E}Columns | undefined = undefined>`
  : `<C extends ${E}Columns | undefined = undefined>`;
const _readOpts = _typedInclude ? 'ReadOptions<W, C>' : 'ReadOptions<never, C>';
const _readResult = _typedInclude ? `${E}Result<W, C>` : `${E}Result<${E}NoInclude, C>`;
const _withLine = _typedInclude ? '\n      with: opts?.with,' : '';
_%>
<%# READ-1: `eq` / `inArray` are unconditional — `findById` / `findByIds` use them. %>
import { eq, inArray<%= hasMultiFieldQuery ? ', and' : '' %><%= _needsOrderFns ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% if (eavValueTable) { -%>
import { sql } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient<% if (eavValueTable || hasIntegrationSurface) { %>, DrizzleTx<% } %> } from '<%= drizzleTypeImport %>';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { ColumnsOf, IncludeOf, Relations, ResultOf } from '<%= relationsImport %>';
<%_ if (composedBaseClass) { _%>
import { <%= composedBaseClass %> } from '<%= composedBaseImport %>';
<%_ } else { _%>
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
<%_ capabilityMixins.forEach((cap) => { _%>
import { <%= cap.mixin %> } from '<%= cap.importPath %>';
<%_ }) _%>
<%_ } _%>
<% if (hasIntegrationSurface) { -%>
import type { IntegrationUpsertConfig } from '<%= integrationUpsertConfigImport %>';
<% } -%>
import type { <% if (hasTimestamps || hasSoftDelete || hasUserTracking || tenantScoped) { %>BehaviorConfig, <% } %>ListOptions, ReadOptions, RowFilter } from '<%= baseRepositoryImport %>';
<% if (eavEnabled) { -%>
import { FieldValueService } from '<%= eavFieldValueImportDir %>/<%= eavFieldValueStem %>.service';
<% } -%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<%_ capabilityConfigImports.forEach((imp) => { _%>
import { <%= imp.name %> } from '<%= imp.importPath %>';
<%_ }) _%>
<%_ if (hasIntegrationSurface) { _%>
<%_ integrationParentTableImports.forEach((imp) => { _%>
import { <%= imp.table %> } from '<%= imp.importPath %>';
<%_ }); _%>
<%_ } _%>
<%_ if (hasIntegrationSurface) { _%>

/**
 * Canonical fields a integrated <%= entityName %> write carries (#374). Copy-through
 * columns are typed from the entity; each FK is named by its parent's external
 * id and resolved <%= integrationFkResolvers.length > 0 ? 'in integrationUpsertOne' : 'as configured' %>. Provider/providerMetadata are persistence
 * seam, not carried here.
 */
export interface <%= classNames.entity %>IntegrationWrite {
  readonly externalId: string;
<%_ integrationWriteFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
<%_ integrationWriteFkFields.forEach((f) => { _%>
  readonly <%= f.name %>?: <%- f.tsType %>;
<%_ }); _%>
  /** Flat custom-field bag (EAV). */
  readonly fields?: globalThis.Record<string, unknown>;
}

/**
 * Canonical-projected view of a <%= entityName %> row, keyed for the integration differ
 * (#374). external_id_tracking columns (provider/providerMetadata) are OMITTED;
 * externalId is kept.
 */
export interface <%= classNames.entity %>IntegrationProjection {
<%_ integrationProjectionFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
}
<%_ } _%>

/**
 * The root column mask a <%= entityName %> read may take — `{ id?: boolean; … }`
 * (READ-1 §2.2). Inclusion (`true`s) or exclusion (`false`s); never empty.
 */
export type <%= E %>Columns = ColumnsOf<'<%= entityNamePlural %>'>;

/**
 * The relation keys a <%= entityName %> read may include — the `with` surface of
 * `<%= entityNamePlural %>` in this project's graph.
 *
 * `TWith` / `TColumns` are inferred AT THE CALL SITE. Annotating an include or a
 * mask literal with these types widens it and loses the exact result shape, so
 * hoist one into a `const` WITHOUT a type annotation (or with `as const`).
 */
export type <%= E %>Include = IncludeOf<'<%= entityNamePlural %>'>;

/** The default `TWith` — no include. */
export type <%= E %>NoInclude = globalThis.Record<string, never>;

/**
 * The row a <%= entityName %> read resolves to: each included relation nested
 * exactly as asked, the root narrowed by `TColumns` (`undefined` ⇒ every column).
 * `<%= E %>Result` alone is the plain row; `<%= E %>Result<TWith>` is the row
 * with that include. The mask is SECOND so a one-argument `<%= E %>Result<…>`
 * is always an include, never a mask (READ-1 §2.2).
 */
export type <%= E %>Result<
  TWith extends <%= E %>Include = <%= E %>NoInclude,
  TColumns extends <%= E %>Columns | undefined = undefined,
> = ResultOf<'<%= entityNamePlural %>', TWith, TColumns>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `<%= classNames.entity %>Result<<%= classNames.entity %>Include>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type <%= classNames.entity %>ApiResult = <%= classNames.entity %> &
  globalThis.Partial<<%= classNames.entity %>Result<<%= classNames.entity %>Include>>;

@Injectable()
<%_ /* ADR-041: the spine alone, the spine wrapped in one capability mixin, or
      the generated `<Entity>ComposedBase` when two or more stack. Built in
      entity-locals.js so both shapes live in one place. REL-2 (#587) threads
      `Relations` as the spine's THIRD type argument there, so a composed base
      carries the manifest exactly as a bare spine does. */ _%>
export class <%= classNames.repository %> extends <%- repositoryExtendsClause %> {
  readonly table = <%= entityNamePlural %>;
<% if (hasTimestamps || hasSoftDelete || hasUserTracking || tenantScoped) { -%>

  // Behaviors declared in YAML -> generated as config object
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: <%= !!hasTimestamps %>,
    softDelete: <%= !!hasSoftDelete %>,
    userTracking: <%= !!hasUserTracking %>,
    tenantScoped: <%= !!tenantScoped %>,
<% if (tenantScoped) { -%>
    tenantColumn: '<%= behaviorTenantColumn %>',
<% } -%>
  };
<% } -%>
<% if (tenantScoped) { -%>

  // ADR-042 / TEN-1 — a tenant-scoped entity enforces STRICTLY, with no
  // opt-down: a missing ambient tenant throws rather than reading the union of
  // every tenant (charter I3). Install the boundary that supplies `tenantId`
  // BEFORE flipping `tenant_scoped: true`; see the ADR's rollout section.
  //
  // The same knob governs the user axis, so a tenant-scoped entity that also
  // declares `user_tracking` is strict for that too. Both axes read the same
  // ambient context, and a missing boundary is a missing boundary.
  protected override readonly scopeEnforcement = 'strict' as const;
<% } -%>
<% if (hasPatternConfig) { -%>

  // Per-entity `<%= patternName %>` pattern config (from YAML `config:` block).
  // The pattern's base class declares `protected readonly patternConfig: TConfig`
  // typed via its `configSchema`; this concrete record is read by the base at
  // runtime (identical shape to `behaviors: BehaviorConfig`).
  protected override readonly patternConfig = <%- renderPatternConfigLiteral(patternConfig, '  ', '  ') %> as const;
<% } -%>
<%_ capabilityMixins.filter((cap) => cap.hasConfig).forEach((cap) => { _%>

  // Per-entity `<%= cap.name %>` capability config (from the entity YAML).
  // The capability's mixin declares `<%= cap.configProperty %>`; this concrete
  // record fills it — ADR-041 §6's config hand-off for a layered capability.
  // Public: a runtime-shipped mixin declares it public (declaration emit,
  // ADR-041.1), and a public override also fills a protected declaration.
  override readonly <%= cap.configProperty %> = <%- renderPatternConfigLiteral(cap.config, '  ', '  ') %> as const;
<%_ }) _%>
<%_ if (hasIntegrationSurface) { _%>

  // Inbound-integration write surface (#374). Drives the generic integrationUpsertOne /
  // findByExternalIdProjected / softDeleteByExternalId on the base. FK
  // resolvers carry LIVE Drizzle table handles ('self' → this.table).
  protected readonly integrationConfig: IntegrationUpsertConfig = {
    conflictTarget: [<%- integrationConfig.conflictTarget.map((c) => `'${c}'`).join(', ') %>],
    writeColumns: [<%- integrationConfig.writeColumns.map((c) => `'${c}'`).join(', ') %>],
    fkResolvers: [
<%_ integrationFkResolvers.forEach((fk) => { _%>
      { column: '<%= fk.column %>', writeKey: '<%= fk.writeKey %>', refTable: <%- fk.isSelfFk ? "'self'" : fk.refTable %><%= fk.strict ? ', strict: true' : '' %> },
<%_ }); _%>
    ],
    projectionColumns: [<%- integrationConfig.projectionColumns.map((c) => `'${c}'`).join(', ') %>],
    eav: <%= integrationConfig.eav %>,
    softDelete: <%= integrationConfig.softDelete %>,
  };
<%_ } _%>

<%_ if (eavEnabled) { -%>
  constructor(
    @Inject(DRIZZLE) db: DrizzleClient<Relations>,
    private readonly fieldValues: FieldValueService,
  ) {
    super(db);
    this.requireRelationalQuery('<%= entityNamePlural %>');
    this.claimGeneratedReads(<%= classNames.repository %>);
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
    await this.fieldValues.upsertFieldsTransactional('<%= entityName %>', entityId, userId, fields, db);
  }
<%_ } else { -%>
  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
    // Every read runs on db.query.<%= entityNamePlural %> — fail HERE, naming the cause,
    // if the injected client was built without the relations manifest.
    this.requireRelationalQuery('<%= entityNamePlural %>');
    // findById / findByIds / list are defined below, so a pattern base class or
    // capability mixin overriding one of them would never run — throw, naming it.
    this.claimGeneratedReads(<%= classNames.repository %>);
  }
<%_ } -%>

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1, docs/specs/READ-1.md; REL-2 #587)
  //
  // Every read takes the same shape knobs — a root `columns` mask<% if (_typedInclude) { %> and a
  // typed `with` include<% } %> — inferred at the call site. The signatures live HERE,
  // not on the base: with `TRelations` and the table key as naked type
  // parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2 §2.1).
  //
  // ONE execution path for the read surface below — `findById`, `findByIds`,
  // `list` and every plain `queries:` / `belongs_to` finder run on RQBv2
  // (`db.query.<%= entityNamePlural %>`), with or without options. (`count`, and a
  // `via:` / `select:` finder, keep the core builder's `scopeAnd`.) The root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"<%= entityNamePlural %>" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

<%_ /* ADR-046: one loop over the derived, emitted repository methods; `m.kind`
      chooses the body. Names and parameter names are printed, never built. */ _%>
<%_ _methods.forEach((m) => { _%>
<%_ if (m.kind === 'find_by_id') { _%>
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: string,
    opts?: <%- _readOpts %>,
  ): Promise<<%- _readResult %> | null> {
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, <%= m.params[0].name %>)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
  }
<%_ } else if (m.kind === 'find_by_ids') { _%>

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none (after the scope's
   * boundary check), duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: readonly string[],
    opts?: <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const unique = this.uniqueIds(<%= m.params[0].name %>);
    if (unique.length === 0) {
      // No statement — but the same boundary check one would make (strict throws).
      this.assertReadScope();
      return [];
    }
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,<%- _withLine %>
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'list') { _%>

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>?: ListOptions<typeof <%= entityNamePlural %>> & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const sort = <%= m.params[0].name %>?.sort;
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter(<%= m.params[0].name %>?.where) },
      columns: this.checkColumns<C>(<%= m.params[0].name %>?.columns),<%- _typedInclude ? `\n      with: ${m.params[0].name}?.with,` : '' %>
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: <%= m.params[0].name %>?.limit,
      offset: <%= m.params[0].name %>?.offset,
    });
    return rows as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'count') { _%>

  /**
   * `where` is a ROW FILTER over THIS table. Overridden only to type it: inside a
   * capability mixin the base's `count` is typed over `PgTable`, which would let
   * another table's filter through — and, where column names coincide, count on
   * the wrong predicate (READ-1 review R-1).
   */
  override async <%= m.name %>(<%= m.params[0].name %>?: RowFilter<typeof <%= entityNamePlural %>>): Promise<number> {
    return super.<%= m.name %>(<%= m.params[0].name %>);
  }
<%_ /* The section banner prints whenever the YAML declares a by-column finder,
      even one that lost its name to an FK finder below. */ _%>
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<% } -%>
<%_ } else if (m.kind === 'finder' || m.kind === 'finder_projection') { _%>
<%_
// The `by:` columns are the parameters that bind a field; their TS types come
// from `queryTypes`, in the same order.
const _t = queryTypes[m.name];
const _cols = m.params.filter((p) => p.field !== undefined);
const _sig = _cols.map((p, i) => `${p.name}: ${_t.params[i].tsType}`).join(', ');
const _multi = _cols.length > 1;
const _pred = _cols.map((p) => `eq(t.${p.name}, ${p.name})`);
const _predExpr = _multi ? `and(${_pred.join(', ')})` : _pred[0];
_%>
<%_ /* A plain by-column finder takes the read options (READ-1 §2.3). A `select:`
      projection returns picked fields and a `via:` finder joins a junction with
      its own query, so neither carries them — REL-2 §5.4: the read surface
      exposes SHAPES, not queries. */ _%>
<%_ if (m.kind === 'finder_projection') { _%>

  async <%= m.name %>(<%- _sig %>): Promise<<%- _t.returnType %>> {
<% if (m.unique) { -%>
    const rows = await this.baseQuery(<%- _multi ? 'and(' : '' %><%- _cols.map(p => `eq(this.table['${p.name}'], ${p.name})`).join(', ') %><%- _multi ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery(<%- _multi ? 'and(' : '' %><%- _cols.map(p => `eq(this.table['${p.name}'], ${p.name})`).join(', ') %><%- _multi ? ')' : '' %>)<%- _t.order ? `.orderBy(${_t.order.direction}(this.table['${_t.order.property}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ } else { _%>

  async <%= m.name %><%- _readGenerics %>(
    <%- _sig %>,
    opts?: <%- _readOpts %>,
  ): Promise<<%- m.unique ? `${_readResult} | null` : `Array<${_readResult}>` %>> {
<% if (m.unique) { -%>
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
<% } else { -%>
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
<%- _t.order ? `      orderBy: { ${_t.order.property}: '${_t.order.direction}' },\n` : '' %>    });
    return rows as Array<<%- _readResult %>>;
<% } -%>
  }
<%_ } _%>
<%_ } else if (m.kind === 'fk_finder') { _%>
<%_
// The FK column's property is the `belongs_to` entry's own, found by the
// foreign key the derivation names.
const _fkColumn = belongsTo.find((rel) => rel.field === m.params[0].field).camelField;
_%>
<%_ if (m === _firstFkFinder) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // FK traversal methods (from belongs_to relationships — CGP-358b)
  // Called by service-layer composition methods on the inverse (has_many) side.
  // A FK method whose name collides with a unique/via/select declarative query
  // is skipped — that declarative query is the more specific intent and wins.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>

  async <%= m.name %><%- _readGenerics %>(
    <%= m.params[0].name %>: string,
    opts?: { limit?: number } & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.<%= _fkColumn %>, <%= m.params[0].name %>)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
      // A `limit` without an order is an arbitrary subset; `id` makes it one.
      orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
      limit: opts?.limit,
    });
    return rows as Array<<%- _readResult %>>;
  }
<%_ } else if (m.kind === 'eav_upsert') { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // EAV compound writes (task #23) — generated from eav_value_table: true
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Upsert "current" value rows keyed by the composite unique
   * (entity_type, entity_id, field_definition_id). Used by the service's
   * upsertFieldsTransactional to dual-write a bag of dynamic fields
   * atomically with the owning entity. Inherited upsertMany only
   * supports single-column conflict targets — this override uses
   * Drizzle's `onConflictDoUpdate` with an explicit column list.
   */
  async <%= m.name %>(
    <%= m.params[0].name %>: Array<globalThis.Partial<<%= classNames.entity %>>>,
    <%= m.params[1].name %>?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (<%= m.params[0].name %>.length === 0) return [];
    const data = <%= m.params[0].name %>.map((input) =>
      this.withTimestamps(input as globalThis.Record<string, unknown>, 'create'),
    );
    const runner = this.runner(<%= m.params[1].name %>);
    const rows = await runner
      .insert(this.tableRef)
      .values(data)
      .onConflictDoUpdate({
        target: [
          this.col('entityType'),
          this.col('entityId'),
          this.col('fieldDefinitionId'),
        ],
        set: {
          value: sql`excluded.value`,
          userId: sql`excluded.user_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();
    return rows as <%= classNames.entity %>[];
  }
<%_ } _%>
<%_ }) _%>

  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
