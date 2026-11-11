---
to: "<%= outputPaths.repository %>"
force: true
---
<%- generatedBanner %>
import { Injectable, Inject } from '@nestjs/common';
<%_
// CGP-358: FK methods with opts take priority over same-named declarative query impl.
// Always emit FK methods; skip declarative body when FK covers same name.
const _fkMethods = belongsTo;
const _fkMethodNames = new Set(_fkMethods.map(rel => {
  const _p = rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1);
  return `findBy${_p}`;
}));
// A declarative query and an FK-traversal method can resolve to the SAME method
// name (e.g. `findByFieldDefinitionId` from both a `belongs_to` FK and an
// explicit `queries: [{ by: [field_definition_id], unique: true }]`). Emitting
// both is a duplicate function implementation (TS2393). Exactly one wins:
//   - plain non-unique single-param declarative → FK method wins (it accepts
//     `opts` and is a superset), the declarative impl is skipped (CGP-358, the
//     `_skipClpDq` flag below);
//   - unique / via / select declarative → the declarative is the more specific
//     intent (single-row return, junction join, projection), so IT wins and the
//     FK-traversal method is skipped here.
const _emittedDqNames = new Set(
  processedQueries
    .filter((q) => q.isUnique || q.hasVia || q.hasSelect)
    .map((q) => q.methodName),
);
const _skipFkMethod = (name) => _emittedDqNames.has(name);
// READ-1: a plain ordered finder now orders through RQBv2's `orderBy` object, so
// `asc`/`desc` are needed only by an ordered `via:` / `select:` finder.
const _needsOrderFns = processedQueries.some((q) => q.hasOrder && (q.hasVia || q.hasSelect));
const E = classNames.entity;
// READ-1 §2.3 — the generic parameters, options and result of every shaped read.
// `with` exists only where REL-2 §2.5 allows it; `columns` everywhere.
const _readGenerics = includes
  ? `<C extends ${E}Columns | undefined = undefined, W extends ${E}Include = ${E}NoInclude>`
  : `<C extends ${E}Columns | undefined = undefined>`;
const _readOpts = includes ? 'ReadOptions<C, W>' : 'ReadOptions<C, never>';
const _readResult = includes ? `${E}Result<C, W>` : `${E}Result<C>`;
const _withLine = includes ? '\n      with: opts?.with,' : '';
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
import type { <% if (hasTimestamps || hasSoftDelete || hasUserTracking || tenantScoped) { %>BehaviorConfig, <% } %>ListOptions, ReadOptions } from '<%= baseRepositoryImport %>';
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
 * The row a <%= entityName %> read resolves to: the root narrowed by `TColumns`
 * (`undefined` ⇒ every column), each included relation nested exactly as asked.
 * `<%= E %>Result` alone is the plain row.
 */
export type <%= E %>Result<
  TColumns extends <%= E %>Columns | undefined = undefined,
  TWith extends <%= E %>Include = <%= E %>NoInclude,
> = ResultOf<'<%= entityNamePlural %>', TColumns, TWith>;

/**
 * The shape an HTTP read returns: the row, plus any allowlisted relation.
 *
 * The controller merges allowlisted fragments at REQUEST time, so which relations
 * are present is not statically known — one of finitely many literals, but not a
 * single one. So the handler's result type is the widened form: every relation
 * OPTIONAL, the row's own columns required. `<%= classNames.entity %>Result<undefined, <%= classNames.entity %>Include>`
 * (the fully-included shape) would be wrong here — it claims every relation is
 * always present, which no single request produces.
 *
 * Internal callers keep the exact inferred type, because `TWith` is inferred at
 * the call site (REL-2 §2.3/§5.2).
 */
export type <%= classNames.entity %>ApiResult = <%= classNames.entity %> &
  globalThis.Partial<<%= classNames.entity %>Result<undefined, <%= classNames.entity %>Include>>;

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
  }
<%_ } -%>

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1, docs/specs/READ-1.md; REL-2 #587)
  //
  // Every read takes the same shape knobs — a root `columns` mask<% if (includes) { %> and a
  // typed `with` include<% } %> — inferred at the call site. The signatures live HERE,
  // not on the base: with `TRelations` and the table key as naked type
  // parameters, `DBQueryConfig<…>['with']` is a TS2536 (REL-2 §2.1).
  //
  // ONE execution path: every read runs on RQBv2
  // (`db.query.<%= entityNamePlural %>`), with or without options, and its root
  // predicate is ONE call — `this.rootFilter(where)`, the caller's row filter AND
  // this repository's scope, both rendered against the table RQBv2 hands the
  // callback. RQBv2 ALIASES the root (`"<%= entityNamePlural %>" as "d0"`), so
  // anything rendered against the real table name would not be in scope there
  // (REL-2 §10 Found #9, #840). Every HOP is scoped by the relations manifest.
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<%- _readGenerics %>(
    id: string,
    opts?: <%- _readOpts %>,
  ): Promise<<%- _readResult %> | null> {
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
  }

  /**
   * One statement for many ids (READ-1 §2.4): `[]` issues none, duplicates are
   * read once, rows come back in INPUT order, and a missing / soft-deleted /
   * out-of-scope id is simply absent. A mask that omits `id` still orders — `id`
   * is selected and stripped again. Not chunked: Postgres caps a statement at
   * 65 535 parameters.
   */
  override async findByIds<%- _readGenerics %>(
    ids: readonly string[],
    opts?: <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const unique = this.uniqueIds(ids);
    if (unique.length === 0) return [];
    const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
      columns: mask.columns,<%- _withLine %>
    });
    return this.inInputOrder(rows, unique, mask.stripId) as Array<<%- _readResult %>>;
  }

  /**
   * `where` is a ROW FILTER — `(t) => eq(t.name, x)` — never a pre-rendered SQL:
   * it is handed the aliased root. `sort` is column keys, rendered the same way.
   */
  override async list<%- _readGenerics %>(
    query?: ListOptions<typeof <%= entityNamePlural %>> & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const sort = query?.sort;
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter(query?.where) },
      columns: this.checkColumns<C>(query?.columns),<%- includes ? '\n      with: query?.with,' : '' %>
      orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
      limit: query?.limit,
      offset: query?.offset,
    });
    return rows as Array<<%- _readResult %>>;
  }
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>
<%_
// CGP-358: Skip declarative impl when a FK method covers this method name.
// FK methods accept opts, making them a superset of a plain non-unique single-param query.
const _skipClpDq = _fkMethodNames.has(q.methodName) && !q.isUnique && !q.hasVia && !q.hasSelect;
const _pred = q.params.map(p => `eq(t.${p.camelName}, ${p.camelName})`);
const _predExpr = q.hasMultipleParams ? `and(${_pred.join(', ')})` : _pred[0];
_%>
<%_ if (!_skipClpDq) { _%>
<%_ /* A plain by-column finder takes the read options (READ-1 §2.3). A `select:`
      projection returns picked fields and a `via:` finder joins a junction with
      its own query, so neither carries them — REL-2 §5.4: the read surface
      exposes SHAPES, not queries. */ _%>
<%_ if (q.hasVia || q.hasSelect) { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
<% if (q.isUnique) { -%>
    const rows = await this.baseQuery(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)<%- q.hasOrder ? `.orderBy(${q.orderDirection}(this.table['${q.orderBy}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ } else { _%>

  async <%= q.methodName %><%- _readGenerics %>(
    <%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>,
    opts?: <%- _readOpts %>,
  ): Promise<<%- q.isUnique ? `${_readResult} | null` : `Array<${_readResult}>` %>> {
<% if (q.isUnique) { -%>
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
    });
    return (row as <%- _readResult %> | undefined) ?? null;
<% } else { -%>
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => <%- _predExpr %>) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
<%- q.hasOrder ? `      orderBy: { ${q.orderBy}: '${q.orderDirection}' },\n` : '' %>    });
    return rows as Array<<%- _readResult %>>;
<% } -%>
  }
<%_ } _%>
<%_ } _%>
<%_ }) _%>
<% } -%>
<%_ const _emittedFkMethods = _fkMethods.filter(rel => !_skipFkMethod(`findBy${rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1)}`)); _%>
<%_ if (_emittedFkMethods.length > 0) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // FK traversal methods (from belongs_to relationships — CGP-358b)
  // Called by service-layer composition methods on the inverse (has_many) side.
  // A FK method whose name collides with a unique/via/select declarative query
  // is skipped — that declarative query is the more specific intent and wins.
  // ═══════════════════════════════════════════════════════════════════════
<%_ _emittedFkMethods.forEach(rel => { _%>

  async findBy<%= rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1) %><%- _readGenerics %>(
    id: string,
    opts?: { cursor?: string; limit?: number } & <%- _readOpts %>,
  ): Promise<Array<<%- _readResult %>>> {
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: { RAW: this.rootFilter((t) => eq(t.<%= rel.camelField %>, id)) },
      columns: this.checkColumns<C>(opts?.columns),<%- _withLine %>
      limit: opts?.limit,
    });
    return rows as Array<<%- _readResult %>>;
  }
<%_ }) _%>
<%_ } _%>
<% if (eavValueTable) { -%>

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
  async upsertCurrentValues(
    inputs: Array<globalThis.Partial<<%= classNames.entity %>>>,
    tx?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (inputs.length === 0) return [];
    const data = inputs.map((input) =>
      this.withTimestamps(input as globalThis.Record<string, unknown>, 'create'),
    );
    const runner = this.runner(tx);
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
<% } -%>

  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
