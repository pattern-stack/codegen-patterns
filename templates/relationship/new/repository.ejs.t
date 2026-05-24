---
to: "<%= outputPaths.repository %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable, Inject } from '@nestjs/common';
<% if (hasDeclarativeQueries) { -%>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { BaseRepository } from '@shared/base-classes/base-repository';
import { <%= tableVarName %>, type <%= classNames.entity %> } from './<%= name %>.entity';

@Injectable()
export class <%= classNames.repository %> extends BaseRepository<<%= classNames.entity %>> {
  readonly table = <%= tableVarName %>;

  // Behaviors: timestamps always enabled for relationships
  protected override readonly behaviors = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
  };

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in relationship YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

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
<%_ }) _%>
<% } else { -%>

  // TODO: Add relationship-specific query methods here.
<% } -%>
  // Inherited from BaseRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
}
