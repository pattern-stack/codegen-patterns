---
to: "<%= hasDeclarativeQueries ? outputPaths.declarativeQueries : null %>"
force: true
---
<%- generatedBanner %>
<% if (hasDeclarativeQueries) { -%>
/**
 * Declarative Query Use Cases for <%= classNames.entity %>
 * Generated from queries: block in entity YAML — do not edit directly.
 *
 * Each query is an injectable use case class that delegates to the service.
 * Register all via `declarativeQueryClasses` in the module providers.
 */

import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
import type { <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';

<%_
// ADR-046 — one class per `queries:` use case the derivation lists: its class
// name, the service method it calls and that method's parameter names are
// printed, never built. The parameter and return TS text comes from `queryTypes`,
// keyed by the derived method name (PLAN §4.3).
const _useCases = apiSurface.useCases.filter((u) => u.kind === 'query');
const _service = apiSurface.service.methods;
_%>
<% _useCases.forEach((u) => { -%>
<%_
const _m = _service.find((s) => s.name === u.calls.method);
const _t = queryTypes[_m.name];
const _cols = _m.params.filter((p) => p.field !== undefined);
_%>
@Injectable()
export class <%= u.className %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(<%- _cols.map((p, i) => `${p.name}: ${_t.params[i].tsType}`).join(', ') %>): Promise<<%- _t.returnType %>> {
    return this.service.<%= u.calls.method %>(<%= _cols.map(p => p.name).join(', ') %>);
  }
}

<% }) -%>
export const declarativeQueryClasses = [
<% _useCases.forEach((u) => { -%>
  <%= u.className %>,
<% }) -%>
];
<% } -%>
