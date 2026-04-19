---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.searchUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.searchUseCase %>"
force: true
---
<% if (hasSearchQuery) { -%>
import { Injectable } from '@nestjs/common';
import { and, asc, eq<% if (searchQuery.searchField) { %>, ilike<% } %>, type SQL } from 'drizzle-orm';
import type { Page } from '@shared/http/pagination';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from '../<%= entityName %>.entity';

export interface <%= searchQuery.inputTypeName %> {
<% searchQuery.filters.forEach((f) => { -%>
  <%= f.camelName %>?: <%- f.hasChoices ? f.choices.map((c) => `'${c}'`).join(' | ') : f.tsType %>;
<% }) -%>
<% if (searchQuery.searchField) { -%>
  search?: string;
<% } -%>
<% if (searchQuery.paginate) { -%>
  limit: number;
  offset: number;
<% } -%>
}

/**
 * Filtered search use case (task #16).
 *
 * Composes the entity service's `list` + `count` with filter-AND and
 * an optional ilike search on `<%= searchQuery.searchField ?? 'N/A' %>`.
 * Pagination is enforced at the Zod layer in the controller.
 */
@Injectable()
export class <%= searchQuery.useCaseClassName %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(input: <%= searchQuery.inputTypeName %>): Promise<Page<<%= classNames.entity %>>> {
    const conditions: SQL[] = [];
<% searchQuery.filters.forEach((f) => { -%>
<% if (f.isBoolean) { -%>
    if (input.<%= f.camelName %> !== undefined) conditions.push(eq(<%= entityNamePlural %>.<%= f.camelName %>, input.<%= f.camelName %>));
<% } else { -%>
    if (input.<%= f.camelName %>) conditions.push(eq(<%= entityNamePlural %>.<%= f.camelName %>, input.<%= f.camelName %>));
<% } -%>
<% }) -%>
<% if (searchQuery.searchField) { -%>
    if (input.search) conditions.push(ilike(<%= entityNamePlural %>.<%= searchQuery.searchFieldCamel %>, `%${input.search}%`));
<% } -%>

    const where =
      conditions.length === 0 ? undefined :
      conditions.length === 1 ? conditions[0] :
      and(...conditions);

    const [items, total] = await Promise.all([
      this.service.list({ where, limit: input.limit, offset: input.offset, orderBy: asc(<%= entityNamePlural %>.createdAt) }),
      this.service.count(where),
    ]);

    return { items, total, limit: input.limit, offset: input.offset };
  }
}
<% } -%>
