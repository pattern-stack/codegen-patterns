---
to: "<%= hasDeclarativeQueries ? outputPaths.declarativeQueries : null %>"
force: true
---
<% if (hasDeclarativeQueries) { -%>
/**
 * Declarative Query Use Cases for <%= classNames.entity %>
 * Generated from queries: block in relationship YAML — do not edit directly.
 *
 * Each query is an injectable use case class that delegates to the repository.
 * Register all via `declarativeQueryClasses` in the module providers.
 */

import { Injectable } from '@nestjs/common';
import { <%= classNames.repository %> } from '../<%= name %>.repository';
import type { <%= classNames.entity %> } from '../<%= name %>.entity';

<% processedQueries.forEach((q) => { -%>
@Injectable()
export class <%= q.useCaseClassName %> {
  constructor(private readonly repository: <%= classNames.repository %>) {}

  async execute(<%- q.params.map(p => `${p.camelName}: ${p.tsType}`).join(', ') %>): Promise<<%- q.returnType %>> {
    return this.repository.<%= q.methodName %>(<%= q.params.map(p => p.camelName).join(', ') %>);
  }
}

<% }) -%>
export const declarativeQueryClasses = [
<% processedQueries.forEach((q) => { -%>
  <%= q.useCaseClassName %>,
<% }) -%>
];
<% } -%>
