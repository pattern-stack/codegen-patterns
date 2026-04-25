---
to: "<%= outputPaths.service %>"
force: true
---
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { <%= classNames.repository %> } from './<%= name %>.repository';
import type { <%= classNames.entity %> } from './<%= name %>.entity';

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  BaseService<<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= name %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(protected override readonly repository: <%= classNames.repository %>) {
    super(repository);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete
<% if (hasDeclarativeQueries) { %>
  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in relationship YAML)
  // Pass-through to repository — keeps use-cases on the service layer so
  // cross-cutting concerns (analytics, events) stay uniform.
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
    return this.repository.<%= q.methodName %>(<%= q.params.map(p => p.camelName).join(', ') %>);
  }
<%_ }) _%>
<% } %>
}
