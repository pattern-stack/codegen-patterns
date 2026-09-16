---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.repository : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable, Inject } from '@nestjs/common';
<%_
// CGP-358: FK methods with opts take priority over same-named declarative query impl.
// Always emit FK methods; skip declarative body when FK covers same name.
const _fkMethods = (typeof clpBelongsTo !== 'undefined') ? clpBelongsTo : [];
const _fkMethodNamesCLP = new Set(_fkMethods.map(rel => {
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
const _emittedDqNamesCLP = new Set(
  (typeof processedQueries !== 'undefined' ? processedQueries : [])
    .filter((q) => q.isUnique || q.hasVia || q.hasSelect)
    .map((q) => q.methodName),
);
const _skipFkMethodCLP = (name) => _emittedDqNamesCLP.has(name);
const _needsEq = hasDeclarativeQueries || _fkMethods.length > 0;
_%>
<% if (_needsEq) { -%>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% } -%>
<% if (eavValueTable) { -%>
import { sql } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '<%= typeof drizzleTokenImport !== 'undefined' ? drizzleTokenImport : '@shared/constants/tokens' %>';
import type { DrizzleClient<% if (eavValueTable || (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface)) { %>, DrizzleTx<% } %> } from '<%= typeof drizzleTypeImport !== 'undefined' ? drizzleTypeImport : '@shared/types/drizzle' %>';
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
<% if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { -%>
import type { IntegrationUpsertConfig } from '<%= typeof integrationUpsertConfigImport !== 'undefined' ? integrationUpsertConfigImport : '@shared/base-classes/integration-upsert-config' %>';
<% } -%>
<% if (hasTimestamps || hasSoftDelete || hasUserTracking) { -%>
import type { BehaviorConfig } from '<%= typeof baseRepositoryImport !== 'undefined' ? baseRepositoryImport : '@shared/base-classes/base-repository' %>';
<% } -%>
<% if (eavEnabled) { -%>
import { FieldValueService } from '../field_values/field_value.service';
<% } -%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';
<%_ if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { _%>
<%_ clpIntegrationParentTableImports.forEach((imp) => { _%>
import { <%= imp.table %> } from '<%= imp.importPath %>';
<%_ }); _%>
<%_ } _%>
<%_ if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { _%>

/**
 * Canonical fields a integrated <%= entityName %> write carries (#374). Copy-through
 * columns are typed from the entity; each FK is named by its parent's external
 * id and resolved <%= clpIntegrationFkResolvers.length > 0 ? 'in integrationUpsertOne' : 'as configured' %>. Provider/providerMetadata are persistence
 * seam, not carried here.
 */
export interface <%= classNames.entity %>IntegrationWrite {
  readonly externalId: string;
<%_ clpIntegrationWriteFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
<%_ clpIntegrationWriteFkFields.forEach((f) => { _%>
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
<%_ clpIntegrationProjectionFields.forEach((f) => { _%>
  readonly <%= f.camelName %>: <%- f.tsType %>;
<%_ }); _%>
}
<%_ } _%>

@Injectable()
<%_ if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { _%>
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><
  <%= classNames.entity %>,
  <%= classNames.entity %>IntegrationWrite,
  <%= classNames.entity %>IntegrationProjection
> {
<%_ } else { _%>
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
<%_ } _%>
  readonly table = <%= entityNamePlural %>;
<% if (hasTimestamps || hasSoftDelete || hasUserTracking) { -%>

  // Behaviors declared in YAML -> generated as config object
  protected override readonly behaviors: BehaviorConfig = {
    timestamps: <%= !!hasTimestamps %>,
    softDelete: <%= !!hasSoftDelete %>,
    userTracking: <%= !!hasUserTracking %>,
  };
<% } -%>
<% if (hasPatternConfig) { -%>

  // Per-entity `<%= patternName %>` pattern config (from YAML `config:` block).
  // The pattern's base class declares `protected readonly patternConfig: TConfig`
  // typed via its `configSchema`; this concrete record is read by the base at
  // runtime (identical shape to `behaviors: BehaviorConfig`).
  protected override readonly patternConfig = <%- renderPatternConfigLiteral(patternConfig, '  ', '  ') %> as const;
<% } -%>
<%_ if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { _%>

  // Inbound-integration write surface (#374). Drives the generic integrationUpsertOne /
  // findByExternalIdProjected / softDeleteByExternalId on the base. FK
  // resolvers carry LIVE Drizzle table handles ('self' → this.table).
  protected readonly integrationConfig: IntegrationUpsertConfig = {
    conflictTarget: [<%- clpIntegrationConfig.conflictTarget.map((c) => `'${c}'`).join(', ') %>],
    writeColumns: [<%- clpIntegrationConfig.writeColumns.map((c) => `'${c}'`).join(', ') %>],
    fkResolvers: [
<%_ clpIntegrationFkResolvers.forEach((fk) => { _%>
      { column: '<%= fk.column %>', writeKey: '<%= fk.writeKey %>', refTable: <%- fk.isSelfFk ? "'self'" : fk.refTable %><%= fk.strict ? ', strict: true' : '' %> },
<%_ }); _%>
    ],
    projectionColumns: [<%- clpIntegrationConfig.projectionColumns.map((c) => `'${c}'`).join(', ') %>],
    eav: <%= clpIntegrationConfig.eav %>,
    softDelete: <%= clpIntegrationConfig.softDelete %>,
  };
<%_ } _%>

<%_ if (eavEnabled) { -%>
  constructor(
    @Inject(DRIZZLE) db: DrizzleClient,
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
  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }
<%_ } -%>
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>
<%_
// CGP-358: Skip declarative impl when a FK method covers this method name.
// FK methods accept opts, making them a superset of a plain non-unique single-param query.
const _skipClpDq = _fkMethodNamesCLP.has(q.methodName) && !q.isUnique && !q.hasVia && !q.hasSelect;
_%>
<%_ if (!_skipClpDq) { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
<% if (q.isUnique) { -%>
    const rows = await this.baseQuery()
      .where(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery()
      .where(<%- q.hasMultipleParams ? 'and(' : '' %><%- q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%- q.hasMultipleParams ? ')' : '' %>)<%- q.hasOrder ? `.orderBy(${q.orderDirection}(this.table['${q.orderBy}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ } _%>
<%_ }) _%>
<% } else { -%>

  // TODO: Add entity-specific query methods here.
<% } -%>
<%_ const _emittedFkMethods = _fkMethods.filter(rel => !_skipFkMethodCLP(`findBy${rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1)}`)); _%>
<%_ if (_emittedFkMethods.length > 0) { _%>

  // ═══════════════════════════════════════════════════════════════════════
  // FK traversal methods (from belongs_to relationships — CGP-358b)
  // Called by service-layer composition methods on the inverse (has_many) side.
  // A FK method whose name collides with a unique/via/select declarative query
  // is skipped — that declarative query is the more specific intent and wins.
  // ═══════════════════════════════════════════════════════════════════════
<%_ _emittedFkMethods.forEach(rel => { _%>

  async findBy<%= rel.camelField.charAt(0).toUpperCase() + rel.camelField.slice(1) %>(id: string, opts?: { cursor?: string; limit?: number }): Promise<<%= classNames.entity %>[]> {
    let q = this.baseQuery().where(eq(this.table['<%= rel.camelField %>'], id));
    if (opts?.limit) q = (q as any).limit(opts.limit);
    return (await q) as <%= classNames.entity %>[];
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
    inputs: Array<Partial<<%= classNames.entity %>>>,
    tx?: DrizzleTx,
  ): Promise<<%= classNames.entity %>[]> {
    if (inputs.length === 0) return [];
    const data = inputs.map((input) =>
      this.withTimestamps(input as Record<string, unknown>, 'create'),
    );
    const runner = this.runner(tx);
    const rows = await runner
      .insert(this.table)
      .values(data as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .onConflictDoUpdate({
        target: [
          this.table['entityType'],
          this.table['entityId'],
          this.table['fieldDefinitionId'],
        ],
        set: {
          value: sql`excluded.value`,
          userId: sql`excluded.user_id`,
          updatedAt: sql`excluded.updated_at`,
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
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
