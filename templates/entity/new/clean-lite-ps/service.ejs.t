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
import { FieldValueRepository } from '../field_values/field_value.repository';
import { mergeEavRows } from '@shared/eav-helpers';
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
    private readonly fieldValueRepository: FieldValueRepository,
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
   * into a single `fields` bag. Cross-domain read — permitted at the service
   * layer. Use this for frontend detail views, LLM context, exports.
   */
  async findByIdWithFields(
    id: string,
  ): Promise<(<%= classNames.entity %> & { fields: Record<string, unknown> }) | null> {
    const entity = await this.repository.findById(id);
    if (!entity) return null;
    const rows = await this.fieldValueRepository.findByEntityIdAndType(id, '<%= entityName %>');
    return { ...entity, fields: mergeEavRows(rows) };
  }

  /**
   * EAV paired read (ADR-13): list variant. Fetches all entities then merges
   * each one's EAV rows. Acceptable for modest result sets; page externally
   * for large collections.
   */
  async listWithFields(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    const entities = await this.repository.list();
    if (entities.length === 0) return [];
    const merged = await Promise.all(
      entities.map(async (entity) => {
        const rows = await this.fieldValueRepository.findByEntityIdAndType(entity.id, '<%= entityName %>');
        return { ...entity, fields: mergeEavRows(rows) };
      }),
    );
    return merged;
  }
<% } %>
}
