---
to: "<%= outputPaths.searchUseCase %>"
skip_if: "<%= !outputPaths.searchUseCase %>"
force: true
---
<%- generatedBanner %>
<% if (hasSearchQuery) { -%>
import { Injectable } from '@nestjs/common';
import { and, eq<% if (searchQuery.searchField) { %>, ilike<% } %>, type SQL } from 'drizzle-orm';
import type { ListQuery, Page } from '<%= paginationImport %>';
import { <%= classNames.listUseCase %> } from './list-<%= entityPluralFileStem %>.use-case';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';

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
@Injectable()
export class <%= searchQuery.useCaseClassName %> {
  constructor(private readonly listUseCase: <%= classNames.listUseCase %>) {}

  async execute(searchInput: <%= searchQuery.inputTypeName %>): Promise<Page<<%= classNames.entity %>>> {
    const whereTerms: SQL[] = [];
<% searchQuery.filters.forEach((f) => { -%>
<% if (f.isBoolean) { -%>
    if (searchInput.<%= f.camelName %> !== undefined) whereTerms.push(eq(<%= entityNamePlural %>.<%= f.camelName %>, searchInput.<%= f.camelName %>));
<% } else { -%>
    if (searchInput.<%= f.camelName %>) whereTerms.push(eq(<%= entityNamePlural %>.<%= f.camelName %>, searchInput.<%= f.camelName %>));
<% } -%>
<% }) -%>
<% if (searchQuery.searchField) { -%>
    if (searchInput.search) whereTerms.push(ilike(<%= entityNamePlural %>.<%= searchQuery.searchFieldCamel %>, `%${searchInput.search}%`));
<% } -%>

    return this.listUseCase.execute(searchInput, { where: and(...whereTerms) });
  }
}
<% } -%>
