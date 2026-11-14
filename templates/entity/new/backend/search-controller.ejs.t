---
to: "<%= outputPaths.searchController %>"
skip_if: "<%= !apiSurface.http.routes.some((r) => r.useCase === apiSurface.useCases.find((u) => u.kind === 'search')?.className) %>"
force: true
---
<%- generatedBanner %>
<%_
// ADR-046 — the search route (its controller, handler, path and use case) is
// the derivation's `search` route (`src/derived/api/`); its filters schema is
// type text and stays in `searchQuery` (slice 2).
const _searchUseCase = apiSurface.useCases.find((u) => u.kind === 'search');
const _search = _searchUseCase && apiSurface.http.routes.find((r) => r.useCase === _searchUseCase.className);
// The controller prefix is the list route's path (`GET /<prefix>`); a search
// route exists only beside it (the body renders before hygen reads `skip_if`).
const _listUseCase = apiSurface.useCases.find((u) => u.kind === 'list');
const _list = apiSurface.http.routes.find((r) => r.useCase === _listUseCase.className);
const _prefix = _list ? _list.path : '';
_%>
<% if (_search) { -%>
import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '<%= zodValidationPipeImport %>';
import { ListQuerySchema, type Page } from '<%= paginationImport %>';
import { <%= _search.useCase %> } from './use-cases/search-<%= entityPluralFileStem %>.use-case';
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
@Controller('<%= _prefix.slice(1) %>')
export class <%= _search.controller %> {
  constructor(private readonly searchUseCase: <%= _search.useCase %>) {}

  @Get('<%= _search.path.slice(_prefix.length + 1) %>')
  async <%= _search.handler %>(
    @Query(new ZodValidationPipe(<%= searchQuery.filtersSchemaName %>))
    query: z.infer<typeof <%= searchQuery.filtersSchemaName %>>,
  ): Promise<Page<<%= classNames.entity %>>> {
    return this.searchUseCase.execute(query);
  }
}
<% } -%>
