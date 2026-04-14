---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.repository : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Injectable, Inject } from '@nestjs/common';
<% if (hasDeclarativeQueries) { -%>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
  readonly table = <%= entityNamePlural %>;

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

  async <%= q.methodName %>(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
<% if (q.isUnique) { -%>
    const rows = await this.baseQuery()
      .where(<%= q.hasMultipleParams ? 'and(' : '' %><%= q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%= q.hasMultipleParams ? ')' : '' %>)
      .limit(1);
    return (rows[0] as <%= classNames.entity %>) ?? null;
<% } else { -%>
    const rows = await this.baseQuery()
      .where(<%= q.hasMultipleParams ? 'and(' : '' %><%= q.params.map(p => `eq(this.table['${p.camelName}'], ${p.camelName})`).join(', ') %><%= q.hasMultipleParams ? ')' : '' %>)<%= q.hasOrder ? `.orderBy(${q.orderDirection}(this.table['${q.orderBy}']))` : '' %>;
    return rows as <%= classNames.entity %>[];
<% } -%>
  }
<%_ }) _%>
<% } else { -%>

  // TODO: Add entity-specific query methods here.
<% } -%>
  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
