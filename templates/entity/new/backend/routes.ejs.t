---
to: "<%= outputPaths.routes %>"
skip_if: "<%= !apiSurface.http.routesFunction %>"
force: true
---
<%- generatedBanner %>
<%_ if (outputPaths.routes) { _%>
<%_
// H-1b — this template PRINTS the entity's Hono routes from `apiSurface.commands` (`src/derived/api/`): each routed
// command's verb, path, binding and success status are the derivation's. A route only binds the request onto its
// command's input and answers with the outcome; validation, includes and error bodies are the command's.
// Static paths are registered before `/:id` ones, so `/<plural>/search` is never read as an id.
const _routed = apiSurface.commands
  .map((c, index) => ({ c, index }))
  .filter(({ c }) => c.http);
const _ordered = [
  ..._routed.filter(({ c }) => !c.http.path.includes('/:')),
  ..._routed.filter(({ c }) => c.http.path.includes('/:')),
];
const _fields = (c) => [
  ...(c.http.binding.path.includes('id') ? ['id'] : []),
  ...(Array.isArray(c.http.binding.query) ? c.http.binding.query.map((q) => `${q}: c.req.query('${q}')`) : []),
];
_%>
/**
 * <%= classNames.entity %>'s HTTP routes (H-1b), as views of its commands: each binds the request onto its command's
 * input, runs it, and answers with the result or the refusal (the bodies are the Nest target's). `<generated>/http.ts`
 * mounts them.
 */
import { Hono } from 'hono';
import { answer<% if (_routed.some(({ c }) => c.http.binding.path.includes('id'))) { %>, badId<% } %><% if (_routed.some(({ c }) => c.http.binding.body)) { %>, bindInput, jsonBody<% } %><% if (_routed.some(({ c }) => c.http.binding.query === 'all')) { %>, queryOf<% } %> } from '<%= httpRuntimeImport %>';
import { invokeCommand } from '<%= commandsImport %>';
import { <%= apiSurface.commandsConst %> } from './<%= entityFileStem %>.commands';
import type { <%= classNames.entity %>Services } from './<%= entityFileStem %>.wiring';

export function <%= apiSurface.http.routesFunction %>(useCases: <%= classNames.entity %>Services['useCases']): Hono {
  const app = new Hono();
<% _ordered.forEach(({ c, index }) => { -%>

  // <%= c.name %>: <%= c.summary %>
  app.<%= c.http.verb.toLowerCase() %>('<%= c.http.path %>', async (c) => {
<% if (c.http.binding.path.includes('id')) { -%>
    const id = c.req.param('id');
    const malformed = badId(c, id);
    if (malformed) return malformed;
<% } -%>
<% if (c.http.binding.body) { -%>
    const read = await jsonBody(c);
    if (!read.ok) return read.response;
    const input = bindInput(read.body, { <%- _fields(c).join(', ') %> });
<% } else if (c.http.binding.query === 'all') { -%>
    const input = { ...queryOf(c)<%- _fields(c).length > 0 ? `, ${_fields(c).join(', ')}` : '' %> };
<% } else { -%>
    const input = { <%- _fields(c).join(', ') %> };
<% } -%>
    return answer(c, await invokeCommand(<%= apiSurface.commandsConst %>[<%= index %>], useCases, input, {}), <%= c.http.success %>);
  });
<% }) -%>
  return app;
}
<%_ } _%>
