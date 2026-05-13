---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.service : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';
<% if (eavEnabled) { -%>
import { FieldValueService } from '../field_values/field_value.service';
<% } -%>
<% if (eavValueTable) { -%>
import { toEavRows, mergeEavRows } from '@shared/eav-helpers';
import type { DrizzleTx } from '@shared/types/drizzle';
import { <%= eavDefinitionPascal %>Repository } from '../<%= eavDefinitionEntityPlural %>/<%= eavDefinitionEntity %>.repository';
<% } -%>
<%_ /* CGP-358b — service-layer composition: import target repos for belongs_to relationships */ _%>
<%_ if (typeof clpBelongsTo !== 'undefined') { _%>
<%_ const uniqueBelongsToTargets = [...new Map(clpBelongsTo.filter(r => !r.isSelfFk).map(r => [r.relatedEntity, r])).values()]; _%>
<%_ uniqueBelongsToTargets.forEach(rel => { _%>
import { <%= rel.relatedEntityPascal %>Repository } from '../<%= rel.relatedPlural %>/<%= rel.relatedEntity %>.repository';
import type { <%= rel.relatedEntityPascal %> } from '../<%= rel.relatedPlural %>/<%= rel.relatedEntity %>.entity';
<%_ }) _%>
<%_ } _%>
<%_ /* CGP-358b — import target repos for has_many relationships */ _%>
<%_ if (typeof clpExistingHasMany !== 'undefined') { _%>
<%_ const uniqueHasManyTargets = [...new Map(clpExistingHasMany.filter(r => !r.isSelfRef).map(r => [r.target, r])).values()]; _%>
<%_ uniqueHasManyTargets.forEach(rel => { _%>
import { <%= rel.targetClass %>Repository } from '../<%= rel.targetPlural %>/<%= rel.target %>.repository';
import type { <%= rel.targetClass %> } from '../<%= rel.targetPlural %>/<%= rel.target %>.entity';
<%_ }) _%>
<%_ } _%>

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= entityName %>';
<% if (hasPatternConfig) { -%>

  // Per-entity `<%= patternName %>` pattern config (from YAML `config:` block).
  // Mirrors the repository-side emission; the pattern's base service reads
  // `this.patternConfig` directly.
  protected override readonly patternConfig = <%- renderPatternConfigLiteral(patternConfig, '  ', '  ') %> as const;
<% } -%>

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: <%= classNames.repository %>,
<% if (eavEnabled) { -%>
    private readonly fieldValues: FieldValueService,
<% } -%>
<% if (eavValueTable) { -%>
    private readonly definitionRepo: <%= eavDefinitionPascal %>Repository,
<% } -%>
<%_ /* CGP-358b — inject target repos for belongs_to (non-self-ref) */ _%>
<%_ if (typeof clpBelongsTo !== 'undefined') { _%>
<%_ const uniqueBelongsToTargets2 = [...new Map(clpBelongsTo.filter(r => !r.isSelfFk).map(r => [r.relatedEntity, r])).values()]; _%>
<%_ uniqueBelongsToTargets2.forEach(rel => { _%>
    private readonly <%= rel.relatedEntity.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) %>Repo: <%= rel.relatedEntityPascal %>Repository,
<%_ }) _%>
<%_ } _%>
<%_ /* CGP-358b — inject target repos for has_many (non-self-ref) */ _%>
<%_ if (typeof clpExistingHasMany !== 'undefined') { _%>
<%_ const uniqueHasManyTargets2 = [...new Map(clpExistingHasMany.filter(r => !r.isSelfRef).map(r => [r.target, r])).values()]; _%>
<%_ uniqueHasManyTargets2.forEach(rel => { _%>
    private readonly <%= rel.target.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) %>Repo: <%= rel.targetClass %>Repository,
<%_ }) _%>
<%_ } _%>
  ) {
    super(repository);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from <%= serviceBaseClass %>:
<%_ serviceInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
<% if (hasDeclarativeQueries) { %>
  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // Pass-through to repository — keeps use-cases on the service layer so
  // cross-cutting concerns (analytics, events) stay uniform.
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
    return this.repository.<%= q.methodName %>(<%= q.params.map(p => p.camelName).join(', ') %>);
  }
<%_ }) _%>
<% } %>
<%_ /* CGP-358b — service-layer composition methods for relationships */ _%>
<%_ const hasBelongsToComposition = typeof clpBelongsTo !== 'undefined' && clpBelongsTo.length > 0; _%>
<%_ const hasHasManyComposition = typeof clpExistingHasMany !== 'undefined' && clpExistingHasMany.length > 0; _%>
<%_ if (hasBelongsToComposition || hasHasManyComposition) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN. Core-contract path; relations() const stays
  // as opt-in extension for hand-written Drizzle queries.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ if (hasBelongsToComposition) { _%>
<%_ clpBelongsTo.forEach(rel => { _%>
<%_ const relCamel = rel.relatedEntity.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); _%>
<%_ const entityCamel = entityName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); _%>

  /**
   * Fetch the <%= rel.relatedEntityPascal %> parent for this <%= entityNamePascal %>.
   * Two repo calls: find self by id → find target by FK.
   */
  async <%= rel.relationKey %>(<%- entityCamel %>Id: string): Promise<<%= rel.relatedEntityPascal %> | null> {
    const entity = await this.repository.findById(<%- entityCamel %>Id);
    if (!entity) return null;
<%_ if (rel.isSelfFk) { _%>
    return entity.<%= rel.camelField %> ? this.repository.findById(entity.<%= rel.camelField %>) : null;
<%_ } else { _%>
    return entity.<%= rel.camelField %> ? this.<%= relCamel %>Repo.findById(entity.<%= rel.camelField %>) : null;
<%_ } _%>
  }
<%_ }) _%>
<%_ } _%>
<%_ if (hasHasManyComposition) { _%>
<%_ clpExistingHasMany.forEach(rel => { _%>
<%_ const relCamel = rel.target.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); _%>
<%_ const entityCamel = entityName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); _%>
<%_ const fkPascal = rel.inverseForeignKeyPascal; _%>

  /**
   * Fetch <%= rel.name %> for this <%= entityNamePascal %> by FK traversal.
   * Single repo call with optional cursor/limit pagination.
   */
  async <%= rel.name %>(<%- entityCamel %>Id: string, opts?: { cursor?: string; limit?: number }): Promise<<%= rel.targetClass %>[]> {
<%_ if (rel.isSelfRef) { _%>
    return this.repository.findBy<%= fkPascal %>(<%- entityCamel %>Id, opts);
<%_ } else { _%>
    return this.<%= relCamel %>Repo.findBy<%= fkPascal %>(<%- entityCamel %>Id, opts);
<%_ } _%>
  }
<%_ }) _%>
<%_ } _%>
<% if (eavEnabled) { %>
  /**
   * EAV paired read (ADR-13): fetch the entity and merge dynamic `field_values`
   * into a single `fields` bag. FieldValueService owns the FieldDefinition
   * lookup internally. Use this for frontend detail views, LLM context,
   * exports.
   */
  async findByIdWithFields(
    id: string,
  ): Promise<(<%= classNames.entity %> & { fields: Record<string, unknown> }) | null> {
    const entity = await this.repository.findById(id);
    if (!entity) return null;
    const fields = await this.fieldValues.findMergedByEntity('<%= entityName %>', id);
    return { ...entity, fields };
  }

  /**
   * EAV paired read (ADR-13): list variant. Fetches all entities then merges
   * each one's EAV fields via FieldValueService. Acceptable for modest result
   * sets; page externally for large collections.
   */
  async listWithFields(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    const entities = await this.repository.list();
    if (entities.length === 0) return [];
    return Promise.all(
      entities.map(async (entity) => {
        const fields = await this.fieldValues.findMergedByEntity('<%= entityName %>', entity.id);
        return { ...entity, fields };
      }),
    );
  }
<% } %>
<% if (eavValueTable) { %>
  /**
   * EAV compound write (task #23) — upserts a bag of dynamic fields onto
   * an owning entity in a single transaction. Resolves field keys to
   * definition ids internally (by reading <%= eavDefinitionPascal %>Repository),
   * so use-cases inject only this service. Unknown keys are skipped; the
   * caller is expected to have created the definitions first (auto-create
   * is a later step).
   */
  async upsertFieldsTransactional(
    entityType: string,
    entityId: string,
    userId: string,
    fields: Record<string, unknown>,
    tx?: DrizzleTx,
  ): Promise<void> {
    if (!fields || Object.keys(fields).length === 0) return;
    const allDefs = await this.definitionRepo.list();
    const defs = allDefs.filter((d) => (d as any).entityType === entityType);
    const defIdByKey = new Map(defs.map((d) => [d.key, d.id]));
    const rows = toEavRows(entityId, entityType, userId, fields, defIdByKey);
    if (rows.length === 0) return;
    await this.repository.upsertCurrentValues(rows as Array<Partial<<%= classNames.entity %>>>, tx);
  }

  /**
   * EAV paired read (task #23) — returns the current merged `{ key: value }`
   * bag for one owning entity. Resolves definition ids to keys internally.
   */
  async findMergedByEntity(
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    const [rows, allDefs] = await Promise.all([
      this.repository.findByEntityIdAndType(entityId, entityType),
      this.definitionRepo.list(),
    ]);
    const defs = allDefs.filter((d) => (d as any).entityType === entityType);
    const defsById = new Map(defs.map((d) => [d.id, { key: d.key }]));
    return mergeEavRows(rows as any, defsById);
  }
<% } %>
}
