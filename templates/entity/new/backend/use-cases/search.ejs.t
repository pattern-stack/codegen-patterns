---
to: "<%= outputPaths.searchUseCase %>"
skip_if: "<%= !outputPaths.searchUseCase %>"
force: true
---
<%- generatedBanner %>
<% if (hasSearchQuery) { -%>
<% if (!plainWiring) { -%>
import { Injectable } from '@nestjs/common';
<% } -%>
import { and, eq<% if (searchQuery.searchField) { %>, ilike<% } %>, type SQL } from 'drizzle-orm';
import type { ListQuery, Page } from '<%= paginationImport %>';
import { <%= classNames.listUseCase %> } from './list-<%= entityPluralFileStem %>.use-case';
<% if (isInheritanceChild) { -%>
import type { <%= entityNamePlural %> } from '../<%= entityFileStem %>.entity';
import type { <%= classNames.entity %>Flat } from '../<%= entityFileStem %>.repository';
<% } else { -%>
import type { <%= entityNamePlural %>, <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';
<% } -%>

/** The list query (paging + sort) plus the declared search filters. */
export interface <%= searchQuery.inputTypeName %> extends ListQuery {
<% searchQuery.filters.forEach((f) => { -%>
  <%= f.camelName %>?: <%- f.hasChoices ? f.choices.map((c) => `'${c}'`).join(' | ') : f.tsType %>;
<% }) -%>
<% if (searchQuery.searchField) { -%>
  search?: string;
<% } -%>
}

/**
 * Filtered search use case — generated from the `queries: - name: search` block.
 *
 * A search is the list with a `where`: it ANDs the declared filters<% if (searchQuery.searchField) { %>
 * (and an ilike on `<%= searchQuery.searchField %>`)<% } %> and pages through `<%= classNames.listUseCase %>`,
 * so paging, sort and the `Page<T>` envelope are the list endpoint's own (#744).
 */
<% if (!plainWiring) { -%>
@Injectable()
<% } -%>
export class <%= searchQuery.useCaseClassName %> {
  constructor(private readonly listUseCase: <%= classNames.listUseCase %>) {}

  async execute(searchInput: <%= searchQuery.inputTypeName %>): Promise<Page<<%= classNames.entity %><%= isInheritanceChild ? 'Flat' : '' %>>> {
    // A ROW FILTER, not a rendered SQL: the list renders it against the table
    // handle its executing path holds — the aliased root on the relational path
    // (READ-1 §4). Built from `t`, never from the imported table.
    const rowFilter = (t: typeof <%= entityNamePlural %>): SQL | undefined => {
      const whereTerms: SQL[] = [];
<% searchQuery.filters.forEach((f) => { -%>
<% if (f.isBoolean) { -%>
      if (searchInput.<%= f.camelName %> !== undefined) whereTerms.push(eq(t.<%= f.camelName %>, searchInput.<%= f.camelName %>));
<% } else { -%>
      if (searchInput.<%= f.camelName %>) whereTerms.push(eq(t.<%= f.camelName %>, searchInput.<%= f.camelName %>));
<% } -%>
<% }) -%>
<% if (searchQuery.searchField) { -%>
      if (searchInput.search) whereTerms.push(ilike(t.<%= searchQuery.searchFieldCamel %>, `%${searchInput.search}%`));
<% } -%>

      return and(...whereTerms);
    };

    // No declared filter set = no `where`. A row filter that happens to render to nothing is still a defined
    // closure, and a child's list routes on whether a `where` is present (RFC-0006 §8): an empty search must read
    // as the plain list, with its default order, not as a filtered one.
    const hasFilter = [
<% searchQuery.filters.forEach((f) => { -%>
<% if (f.isBoolean) { -%>
      searchInput.<%= f.camelName %> !== undefined,
<% } else { -%>
      globalThis.Boolean(searchInput.<%= f.camelName %>),
<% } -%>
<% }) -%>
<% if (searchQuery.searchField) { -%>
      globalThis.Boolean(searchInput.search),
<% } -%>
    ].some(globalThis.Boolean);

    return this.listUseCase.execute(searchInput, hasFilter ? { where: rowFilter } : {});
  }
}
<% } -%>
