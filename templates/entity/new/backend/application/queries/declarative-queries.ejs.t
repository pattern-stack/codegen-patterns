---
to: "<%= hasDeclarativeQueries ? `${basePaths.backendSrc}/${paths.queries}/declarative-queries.ts` : '' %>"
skip_if: <%= !isCleanArchitecture %>
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<% if (hasDeclarativeQueries) { -%>
/**
 * Declarative Query Classes for <%= className %>
 * Generated from queries: block in entity YAML - do not edit directly
 */

import { Inject, Injectable } from '@nestjs/common';
import { <%= repositoryToken %> } from '<%= imports.constants %>';
import type { I<%= className %>Repository } from '<%= imports.domain %>';
import type { <%= className %> } from '<%= imports.domain %>';

<% processedQueries.forEach((q) => { -%>
@Injectable()
export class <%= q.useCaseClassName %> {
	constructor(
		@Inject(<%= repositoryToken %>)
		private readonly repository: I<%= className %>Repository,
	) {}

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
