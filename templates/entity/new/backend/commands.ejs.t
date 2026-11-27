---
to: "<%= outputPaths.commands %>"
force: true
---
<%- generatedBanner %>
<%_ if (outputPaths.commands) { _%>
<%_
// H-1 — this template PRINTS the entity's commands from `apiSurface.commands` (`src/derived/api/`): their names,
// summaries, effects, inputs and include allowlists are the derivation's. The use-case calls stay here.
const _cmds = apiSurface.commands;
const _of = (kind) => _cmds.find((c) => c.kind === kind);
const _typedInclude = apiSurface.repository.typedInclude;
const _allowlisted = _typedInclude && _cmds.some((c) => c.includeRoute);
const _allow = (c) => (c.includeRoute ? `${apiSurface.http.includesConst}.${c.includeRoute}` : 'undefined');
const _create = _of('create');
const _update = _of('update');
const _search = _of('search');
_%>
/**
 * <%= classNames.entity %>'s commands (H-1): each of its use cases as every way in calls it (HTTP, MCP tools, a CLI),
 * with one input object checked by its schema. A refusal (a missing row, an include the allowlist doesn't name, a
 * write the database refuses on a constraint) is an outcome, never a throw; `<generated>/commands.ts` lists every
 * entity's.
 */
import { z } from 'zod';
import { defineCommand } from '@pattern-stack/wiring/commands';
import { attempt<% if (_update || _of('find_by_id_with_fields')) { %>, orNotFound<% } %> } from '<%= commandsImport %>';
import { resolveAllowedInclude } from '<%= includesImport %>';
<% if (_search) { -%>
import { ListQuerySchema } from '<%= paginationImport %>';
<% } -%>
import { <%= classNames.listQuerySchema %> } from './dto/list-<%= entityPluralFileStem %>.query';
<% if (_create) { -%>
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
<% } -%>
<% if (_update) { -%>
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
<% } -%>
<% if (_allowlisted) { -%>
import { <%= apiSurface.http.includesConst %> } from '<%= apiIncludesImport %>';
<% } -%>
import type { <%= classNames.entity %>Services } from './<%= entityFileStem %>.wiring';

/** What <%= classNames.entity %>'s commands run on: its use cases, as its context's composition builds them. */
type UseCases = <%= classNames.entity %>Services['useCases'];
<% if (_search) { -%>

/** The search's input: the list query (paging, sort) plus the filters declared in <%= entityName %>.yaml. */
const <%= searchQuery.filtersSchemaName %> = ListQuerySchema.extend({
<% searchQuery.filtersSchemaFields.forEach((line) => { -%>
<%- line %>
<% }) -%>
});
<% } -%>

export const <%= apiSurface.commandsConst %> = [
<% _cmds.forEach((c) => { -%>
  defineCommand({
    name: '<%= c.name %>',
    summary: '<%= c.summary %>',
    effect: '<%= c.effect %>',
<%_ if (c.kind === 'list') { _%>
    input: <%= classNames.listQuerySchema %>.extend({ include: z.string().optional() }),
<%_ if (_typedInclude) { _%>
    run: (useCases: UseCases, query) =>
      attempt(() => useCases.<%= c.useCaseKey %>.execute(query, { include: resolveAllowedInclude(query.include, <%- _allow(c) %>) })),
<%_ } else { _%>
    // <%= entityName %> has no relations, so no include exists; one asked for is still refused.
    run: (useCases: UseCases, query) =>
      attempt(() => {
        resolveAllowedInclude(query.include, undefined);
        return useCases.<%= c.useCaseKey %>.execute(query);
      }),
<%_ } _%>
<%_ } else if (c.kind === 'find_by_id') { _%>
    input: z.object({ id: z.guid(), include: z.string().optional() }),
<%_ if (_typedInclude) { _%>
    run: (useCases: UseCases, { id, include }) =>
      attempt(() => useCases.<%= c.useCaseKey %>.execute(id, resolveAllowedInclude(include, <%- _allow(c) %>))),
<%_ } else { _%>
    run: (useCases: UseCases, { id, include }) =>
      attempt(() => {
        resolveAllowedInclude(include, undefined);
        return useCases.<%= c.useCaseKey %>.execute(id);
      }),
<%_ } _%>
<%_ } else if (c.kind === 'list_with_fields') { _%>
    input: z.object({}),
    run: (useCases: UseCases) => attempt(() => useCases.<%= c.useCaseKey %>.execute()),
<%_ } else if (c.kind === 'find_by_id_with_fields') { _%>
    input: z.object({ id: z.guid() }),
    run: (useCases: UseCases, { id }) =>
      attempt(async () => orNotFound(await useCases.<%= c.useCaseKey %>.execute(id), `<%= classNames.entity %> ${id} not found`)),
<%_ } else if (c.kind === 'search') { _%>
    input: <%= searchQuery.filtersSchemaName %>,
    run: (useCases: UseCases, query) => attempt(() => useCases.<%= c.useCaseKey %>.execute(query)),
<%_ } else if (c.kind === 'create') { _%>
    input: <%= classNames.createSchema %>,
    run: (useCases: UseCases, dto) => attempt(() => useCases.<%= c.useCaseKey %>.execute(dto)),
<%_ } else if (c.kind === 'update') { _%>
    input: <%= classNames.updateSchema %>.extend({ id: z.guid() }),
    run: (useCases: UseCases, { id, ...dto }) =>
      attempt(async () => orNotFound(await useCases.<%= c.useCaseKey %>.execute(id, dto), `<%= classNames.entity %> ${id} not found`)),
<%_ } else if (c.kind === 'delete') { _%>
    input: z.object({ id: z.guid() }),
    run: (useCases: UseCases, { id }) => attempt(() => useCases.<%= c.useCaseKey %>.execute(id)),
<%_ } _%>
  }),
<% }) -%>
] as const;
<%_ } _%>
