---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.searchController : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.searchController %>"
force: true
---
<% if (hasSearchQuery) { -%>
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { PaginationSchema } from '@shared/http/pagination';
import { <%= searchQuery.useCaseClassName %> } from './use-cases/search-<%= entityNamePlural %>.use-case';

const <%= searchQuery.filtersSchemaName %> = z.object({
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
}).merge(PaginationSchema);

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

/**
 * Filtered search controller (task #16) — generated from queries:
 * block in <%= entityName %>.yaml.
 */
@Controller('<%= entityNamePlural %>')
export class <%= classNames.searchController %> {
  constructor(private readonly searchUseCase: <%= searchQuery.useCaseClassName %>) {}

  @Get('search')
  async search(@Query() query: Record<string, unknown>) {
    return this.searchUseCase.execute(parseOrThrow(<%= searchQuery.filtersSchemaName %>, query));
  }
}
<% } -%>
