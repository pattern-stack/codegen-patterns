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
const _needsEq = hasDeclarativeQueries || _fkMethods.length > 0;
_%>
<%# REL-2: `eq` is now unconditional — the typed `findById` override uses it. %>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% if (eavValueTable) { -%>
import { sql } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient<% if (eavValueTable || hasIntegrationSurface) { %>, DrizzleTx<% } %> } from '<%= drizzleTypeImport %>';
// REL-2 (#587): the generated relation graph. `Relations` binds the repository's
// third type parameter; `IncludeOf`/`ResultOf` are what make a `with` include
// typed. Generated code reaching a generated manifest — the runtime package never
// sees it (REL-1 §4).
import type { IncludeOf, Relations, ResultOf } from '<%= relationsImport %>';
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
import type { <% if (hasTimestamps || hasSoftDelete || hasUserTracking || tenantScoped) { %>BehaviorConfig, <% } %>ListOptions } from '<%= baseRepositoryImport %>';
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
  readonly fields?: Record<string, unknown>;
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
 * The relation keys a <%= entityName %> read may include — the `with` surface of
 * `<%= entityNamePlural %>` in this project's graph.
 *
 * `TWith` is inferred AT THE CALL SITE. Annotating an include literal with this
 * type widens it and loses the exact result shape, so hoist an include into a
 * `const` WITHOUT a type annotation (or with `as const`) if you need to reuse it.
 */
export type <%= classNames.entity %>Include = IncludeOf<'<%= entityNamePlural %>'>;

/** The row shape a given <%= entityName %> include tree resolves to, nested exactly as asked. */
export type <%= classNames.entity %>Result<TWith extends <%= classNames.entity %>Include> =
  ResultOf<'<%= entityNamePlural %>', TWith>;

/** The default `TWith` — no include, so the plain row. */
export type <%= classNames.entity %>NoInclude = Record<string, never>;

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
  Partial<<%= classNames.entity %>Result<<%= classNames.entity %>Include>>;

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
  }

  /**
   * EAV dual-write override (#374 seam → #124 live path). Delegates to the
   * shared FieldValueService so the inbound-integration write joins the same tx.
   */
  protected override async writeCustomFields(
    db: DrizzleTx,
    entityId: string,
    userId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.fieldValues.upsertFieldsTransactional('<%= entityName %>', entityId, userId, fields, db);
  }
<%_ } else { -%>
  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
  }
<%_ } -%>

<% if (includes) { -%>
  // ═══════════════════════════════════════════════════════════════════════
  // Typed `with` includes (REL-2, #587)
  //
  // The include surface is emitted HERE, not on the base class: with
  // `TRelations` and the relation key as naked type parameters,
  // `DBQueryConfig<…>['with']` is a TS2536, so a generic
  // `BaseRepository.findById<TWith>` cannot be written (REL-2 §2.1). Where both
  // are concrete — this subclass — everything resolves.
  //
  // Two execution paths, one scope. Without a `with` the call goes through
  // `baseQuery()`, whose single `WHERE` carries the guards. With a `with` it
  // goes through RQBv2 (`db.query.<%= entityNamePlural %>`), because `baseQuery()`
  // cannot carry an include — and the root filter injects the SAME predicate via
  // `rootScopeRaw()`. Every HOP is scoped by the relations manifest itself, so a
  // caller cannot reach an unscoped level (REL-2 §1.4/§3).
  //
  // Depth is uncapped here: charter I4 asks for ONE statement, not a shallow
  // one. The depth cap is an HTTP concern (`api.includes.max_depth`).
  // ═══════════════════════════════════════════════════════════════════════

  override async findById<TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    id: string,
    opts?: { with?: TWith },
  ): Promise<<%= classNames.entity %>Result<TWith> | null> {
    if (opts?.with === undefined) {
      const rows = await this.baseQuery(eq(this.table['id'], id)).limit(1);
      return (rows[0] as <%= classNames.entity %>Result<TWith>) ?? null;
    }
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: {
        AND: [
          { id: { eq: id } },
          { RAW: () => this.rootScopeRaw({ softDelete: <%= !!hasSoftDelete %> }) },
        ],
      },
      with: opts.with,
    });
    return (row as <%= classNames.entity %>Result<TWith> | undefined) ?? null;
  }

  override async list<TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    query?: ListOptions & { with?: TWith },
  ): Promise<Array<<%= classNames.entity %>Result<TWith>>> {
    if (query?.with === undefined) {
      return (await super.list(query)) as Array<<%= classNames.entity %>Result<TWith>>;
    }
    if (query.orderBy !== undefined) {
      // A pre-rendered `orderBy` names the table by its REAL name, and RQBv2
      // aliases the root — so the fragment would reference a table that is not in
      // scope and Postgres would reject the statement. Fail loud rather than issue
      // it; pass `sort` instead, which both paths can render (REL-2 §2.4).
      throw new Error(
        '<%= classNames.repository %>.list: `orderBy` cannot be combined with `with` — ' +
          'pass `sort: [{ column, direction }]` instead.',
      );
    }
    const callerWhere = query.where;
    const callerSort = query.sort;
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: {
        AND: [
          ...(callerWhere === undefined ? [] : [{ RAW: callerWhere }]),
          { RAW: () => this.rootScopeRaw({ softDelete: <%= !!hasSoftDelete %> }) },
        ],
      },
      with: query.with,
      // The ALIASED table RQBv2 hands the callback, not this repo's own handle.
      ...(callerSort === undefined ? {} : { orderBy: (t) => this.orderByOn(t, callerSort) ?? [] }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return rows as Array<<%= classNames.entity %>Result<TWith>>;
  }
<% } -%>
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>
<%_
// CGP-358: Skip declarative impl when a FK method covers this method name.
// FK methods accept opts, making them a superset of a plain non-unique single-param query.
const _skipClpDq = _fkMethodNames.has(q.methodName) && !q.isUnique && !q.hasVia && !q.hasSelect;
_%>
<%_ if (!_skipClpDq) { _%>
<%_ /* REL-2: a plain by-column finder takes a typed `with` (spec §4). A `select:`
      projection returns picked fields and a `via:` finder joins a junction with
      its own query, so neither carries an include — §5.4: the include surface
      exposes SHAPES, not queries. */ _%>
<%_ if (q.hasVia || q.hasSelect || !includes) { _%>

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

  async <%= q.methodName %><TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    <%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>,
    opts?: { with?: TWith },
  ): Promise<<%- q.isUnique ? `${classNames.entity}Result<TWith> | null` : `Array<${classNames.entity}Result<TWith>>` %>> {
    if (opts?.with === undefined) {
<% if (q.isUnique) { -%>
      const rows = await this.baseQuery(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)
        .limit(1);
      return (rows[0] as <%= classNames.entity %>Result<TWith>) ?? null;
<% } else { -%>
      const rows = await this.baseQuery(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)<%- q.hasOrder ? `.orderBy(${q.orderDirection}(this.table['${q.orderBy}']))` : '' %>;
      return rows as Array<<%= classNames.entity %>Result<TWith>>;
<% } -%>
    }
<% if (q.isUnique) { -%>
    const row = await this.db.query.<%= entityNamePlural %>.findFirst({
      where: {
        AND: [
<%- q.params.map(p => `          { ${p.camelName}: { eq: ${p.camelName} } },`).join('\n') %>
          { RAW: () => this.rootScopeRaw({ softDelete: <%= !!hasSoftDelete %> }) },
        ],
      },
      with: opts.with,
    });
    return (row as <%= classNames.entity %>Result<TWith> | undefined) ?? null;
<% } else { -%>
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: {
        AND: [
<%- q.params.map(p => `          { ${p.camelName}: { eq: ${p.camelName} } },`).join('\n') %>
          { RAW: () => this.rootScopeRaw({ softDelete: <%= !!hasSoftDelete %> }) },
        ],
      },
      with: opts.with,
<%- q.hasOrder ? `      orderBy: { ${q.orderBy}: '${q.orderDirection}' },\n` : '' %>    });
    return rows as Array<<%= classNames.entity %>Result<TWith>>;
<% } -%>
  }
<%_ } _%>
<%_ } _%>
<%_ }) _%>
<% } else { -%>

  // TODO: Add entity-specific query methods here.
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

<%_ if (!includes) { _%>
  async findBy<%= rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1) %>(id: string, opts?: { cursor?: string; limit?: number }): Promise<<%= classNames.entity %>[]> {
    let q = this.baseQuery(eq(this.table['<%= rel.camelField %>'], id));
    if (opts?.limit) q = q.limit(opts.limit) as typeof q;
    return (await q) as <%= classNames.entity %>[];
  }
<%_ } else { _%>
  async findBy<%= rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1) %><TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    id: string,
    opts?: { cursor?: string; limit?: number; with?: TWith },
  ): Promise<Array<<%= classNames.entity %>Result<TWith>>> {
    if (opts?.with === undefined) {
      let q = this.baseQuery(eq(this.table['<%= rel.camelField %>'], id));
      if (opts?.limit) q = q.limit(opts.limit) as typeof q;
      return (await q) as Array<<%= classNames.entity %>Result<TWith>>;
    }
    const rows = await this.db.query.<%= entityNamePlural %>.findMany({
      where: {
        AND: [
          { <%= rel.camelField %>: { eq: id } },
          { RAW: () => this.rootScopeRaw({ softDelete: <%= !!hasSoftDelete %> }) },
        ],
      },
      with: opts.with,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    return rows as Array<<%= classNames.entity %>Result<TWith>>;
  }
<%_ } _%>
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
    inputs: Array<Partial<<%= classNames.entity %>>>,
    tx?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (inputs.length === 0) return [];
    const data = inputs.map((input) =>
      this.withTimestamps(input as Record<string, unknown>, 'create'),
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
