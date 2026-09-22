---
to: "<%= outputPaths.repository %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable, Inject } from '@nestjs/common';
<% if (hasDeclarativeQueries) { -%>
import { eq<%= hasMultiFieldQuery ? ', and' : '' %><%= hasOrderedQuery ? ', desc, asc' : '' %> } from 'drizzle-orm';
<% } -%>
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
import { BaseRepository } from '<%= baseRepositoryImport %>';
// REL-2 (#587): the generated relation graph binds the repository's third type
// parameter. A relationship table carries no typed `with` of its own yet — its
// per-type edges need the `types:` enum threaded into the manifest, which REL-1
// deliberately left out (REL-1 §5) and #679 will decide alongside junctions.
import type { Relations } from '<%= relationsImport %>';
import { <%= tableVarName %>, type <%= classNames.entity %> } from './<%= entityFileStem %>.entity';

@Injectable()
export class <%= classNames.repository %> extends BaseRepository<<%= classNames.entity %>, typeof <%= tableVarName %>, Relations> {
  readonly table = <%= tableVarName %>;

  // Behaviors: timestamps always enabled for relationships
  protected override readonly behaviors = {
    timestamps: true,
    softDelete: false,
    userTracking: false,
    // Relationship tables are not tenant-scopable in v1 (ADR-042 / TEN-1 §11).
    tenantScoped: false,
  };

  constructor(@Inject(DRIZZLE) db: DrizzleClient<Relations>) {
    super(db);
  }
<% if (hasDeclarativeQueries) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in relationship YAML)
  // ═══════════════════════════════════════════════════════════════════════
<%_ processedQueries.forEach((q) => { _%>

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
<%_ }) _%>
<% } else { -%>

  // TODO: Add relationship-specific query methods here.
<% } -%>
  // Inherited from BaseRepository:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
}
