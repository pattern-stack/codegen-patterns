---
to: "<%= outputPaths.service %>"
force: true
---
<%- generatedBanner %>
import { Injectable, Inject, Optional<% if (junctionFanOut.length > 0) { %>, forwardRef<% } %> } from '@nestjs/common';
import { WithAnalytics } from '<%= withAnalyticsImport %>';
import { EVENT_BUS } from '<%= drizzleTokenImport %>';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import type { <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<% if (eavEnabled) { -%>
import { FieldValueService } from '<%= eavFieldValueImportDir %>/<%= eavFieldValueStem %>.service';
<% } -%>
<% if (eavValueTable) { -%>
import { toEavRows, mergeEavRows } from '<%= eavHelpersImport %>';
import type { DrizzleTx } from '<%= drizzleTypeImport %>';
<% if (!eavDefinitionRepositoryImported) { -%>
import { <%= eavDefinitionPascal %>Repository } from '<%= eavDefinitionImportDir %>/<%= eavDefinitionEntityStem %>.repository';
<% } -%>
<% } -%>
<%_ /* #632 — one import per composed repository (belongs_to + has_many targets, deduped) */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
import { <%= dep.repositoryClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.repository';
import type { <%= dep.entityClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.entity';
<%_ }) _%>
<%_ /* JUNC-0 — each junction this entity is mirrored onto: its service, link + row types, and the counterparty type */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
import { <%= fan.junction.serviceClass %>, <%= fan.junction.linkInputType %> } from '<%= fan.junctionServiceImport %>';
import type { <%= fan.junction.entityClass %> } from '<%= fan.junctionEntityImport %>';
<%_ if (fan.importCounterparty) { _%>
import type { <%= fan.counterpartyPascal %> } from '<%= fan.counterpartyEntityImport %>';
<%_ } _%>
<%_ }) _%>

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
<% if (eavValueTable && !eavDefinitionRepositoryImported) { -%>
    private readonly definitionRepo: <%= eavDefinitionPascal %>Repository,
<% } -%>
<%_ /* #632 — one constructor parameter per composed repository */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
    private readonly <%= dep.property %>: <%= dep.repositoryClass %>,
<%_ }) _%>
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
<%_ /* ADR-041 — capability forwarders. A capability's methods live on the
      repository (its mixin put them there); the service exposes the vocabulary
      the capability declared in `forwarderMethods`. Signatures are derived from
      the repository method, never re-declared (charter I1), and the forwarder is
      deliberately NOT `async`: `ReturnType<…>` is whatever the capability
      method returns, and `async` would require it to be a Promise. */ _%>
<%_ if (capabilityForwarders.length > 0) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Capability forwarders (ADR-041)
  // Pass-through to the repository, where the capability's mixin lives.
  // ═══════════════════════════════════════════════════════════════════════
<%_ capabilityForwarders.forEach((fwd) => { _%>

  /** Contributed by the `<%= fwd.capability %>` capability. */
  <%= fwd.method %>(
    ...args: Parameters<<%= classNames.repository %>['<%= fwd.method %>']>
  ): ReturnType<<%= classNames.repository %>['<%= fwd.method %>']> {
    return this.repository.<%= fwd.method %>(...args);
  }
<%_ }) _%>
<%_ } _%>
<%_ /* CGP-358b — service-layer composition methods for relationships */ _%>
<%_ const hasBelongsToComposition = belongsTo.length > 0; _%>
<%_ const hasHasManyComposition = existingHasMany.length > 0; _%>
<%_ if (hasBelongsToComposition || hasHasManyComposition) { _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ if (hasBelongsToComposition) { _%>
<%_ belongsTo.forEach(rel => { _%>
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
<%_ existingHasMany.forEach(rel => { _%>
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
<%_ /* JUNC-0 (#678) — junction fan-out, mirrored on both parents (CGP-60;
      docs/relationship-pattern-audit.md §1). Rendered here from the junction
      YAML set, so re-running `entity new` or `junction new` in any order gives
      the same file. `forwardRef` resolves the parent ↔ junction module cycle. */ _%>
<%_ if (junctionFanOut.length > 0) { _%>
<%_ /* the queries block ends on a blank line; the forwarder / composition blocks do not */ _%>
<%_ if (capabilityForwarders.length > 0 || hasBelongsToComposition || hasHasManyComposition) { _%>

<%_ } _%>
  // ═══════════════════════════════════════════════════════════════════════
  // Junction fan-out (CGP-60)
  // Delegates to each junction's service; the same association is mirrored
  // on the other parent.
  // ═══════════════════════════════════════════════════════════════════════
<%_ } _%>
<%_ junctionFanOut.forEach(fan => { _%>
<%_ const j = fan.junction; _%>

  // <%= j.name %> — <%= fan.side %> side, fan-out to <%= fan.counterpartyPascal %>
  @Inject(forwardRef(() => <%= j.serviceClass %>))
  private readonly <%= j.serviceProperty %>!: <%= j.serviceClass %>;

  async <%= fan.attachMethod %>(
    <%= fan.selfIdParam %>: string,
    <%= fan.counterpartyIdParam %>: string,
    link?: <%= j.linkInputType %>,
  ): Promise<<%= j.entityClass %>> {
    return this.<%= j.serviceProperty %>.attach(<%= fan.leftIdParam %>, <%= fan.rightIdParam %>, link);
  }

  async <%= fan.detachMethod %>(
    <%= fan.selfIdParam %>: string,
    <%= fan.counterpartyIdParam %>: string,
  ): Promise<void> {
    return this.<%= j.serviceProperty %>.detach(<%= fan.leftIdParam %>, <%= fan.rightIdParam %>);
  }

  async <%= fan.listMethod %>(
    <%= fan.selfIdParam %>: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: <%= fan.counterpartyPascal %>; link: <%= j.entityClass %> }>> {
    return this.<%= j.serviceProperty %>.listAssoc('<%= fan.side %>', <%= fan.selfIdParam %>, opts) as Promise<
      Array<{ entity: <%= fan.counterpartyPascal %>; link: <%= j.entityClass %> }>
    >;
  }

  async <%= fan.setPrimaryMethod %>(
    <%= fan.selfIdParam %>: string,
    <%= fan.counterpartyIdParam %>: string,
  ): Promise<void> {
    return this.<%= j.serviceProperty %>.setPrimary(<%= fan.leftIdParam %>, <%= fan.rightIdParam %>);
  }
<%_ }) _%>
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
<% } -%>
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
    const allDefs = await this.<%= eavDefinitionRepoProperty %>.list();
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
      this.<%= eavDefinitionRepoProperty %>.list(),
    ]);
    const defs = allDefs.filter((d) => (d as any).entityType === entityType);
    const defsById = new Map(defs.map((d) => [d.id, { key: d.key }]));
    return mergeEavRows(rows as any, defsById);
  }
<% } -%>
}
