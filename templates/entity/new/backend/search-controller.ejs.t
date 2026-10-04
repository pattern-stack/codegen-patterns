---
to: "<%= outputPaths.searchController %>"
skip_if: "<%= !outputPaths.searchController || apiEnabled === false %>"
force: true
---
<%- generatedBanner %>
<% if (hasSearchQuery) { -%>
import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '<%= zodValidationPipeImport %>';
import { ListQuerySchema, type Page } from '<%= paginationImport %>';
import { <%= searchQuery.useCaseClassName %> } from './use-cases/search-<%= entityPluralFileStem %>.use-case';
import type { <%= classNames.entity %> } from './<%= entityFileStem %>.entity';

/**
 * The list endpoint's query (page / pageSize / cursor / sort_by / sort_order)
 * extended with the filters declared in <%= entityName %>.yaml — so search pages
 * and sorts exactly as `GET /<%= entityNamePlural %>` does (#744).
 */
const <%= searchQuery.filtersSchemaName %> = ListQuerySchema.extend({
<% searchQuery.filters.forEach((f) => { -%>
<% if (f.isUuid) { -%>
  <%= f.camelName %>: z.string().uuid().optional(),
<% } else if (f.hasChoices) { -%>
  <%= f.camelName %>: z.enum([<%- f.choices.map((c) => `'${c}'`).join(', ') %>]).optional(),
<% } else if (f.isBoolean) { -%>
  <%= f.camelName %>: z.coerce.boolean().optional(),
<% } else if (f.isNumber) { -%>
  <%= f.camelName %>: z.coerce.number().optional(),
<% } else { -%>
  <%= f.camelName %>: z.string().optional(),
<% } -%>
<% }) -%>
<% if (searchQuery.searchField) { -%>
  search: z.string().optional(),
<% } -%>
});

/**
 * Filtered search controller — generated from the `queries: - name: search`
 * block in <%= entityName %>.yaml. Returns the same `Page<T>` envelope as the
 * list endpoint.
 */
@Controller('<%= entityNamePlural %>')
export class <%= classNames.searchController %> {
  constructor(private readonly searchUseCase: <%= searchQuery.useCaseClassName %>) {}

  @Get('search')
  async search(
    @Query(new ZodValidationPipe(<%= searchQuery.filtersSchemaName %>))
    query: z.infer<typeof <%= searchQuery.filtersSchemaName %>>,
  ): Promise<Page<<%= classNames.entity %>>> {
    return this.searchUseCase.execute(query);
  }
}
<% } -%>
