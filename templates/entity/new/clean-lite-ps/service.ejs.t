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

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= entityName %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected readonly repository: <%= classNames.repository %>,
<% if (eavEnabled) { -%>
    private readonly fieldValues: FieldValueService,
<% } -%>
<% if (eavValueTable) { -%>
    private readonly definitionRepo: <%= eavDefinitionPascal %>Repository,
<% } -%>
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
