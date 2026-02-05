---
to: "<%= generate.collections ? `${locations.frontendCollections.path}/collections.ts` : '' %>"
inject: true
after: "// Codegen collections"
skip_if: <%= camelName %>Collection
---
<% if (generate.collections) { -%>
<%
// Determine the URL expression based on config
const hasApiBaseUrl = !!frontend.sync.apiBaseUrlImport;
// For the URL path, use API_BASE_URL if configured
const shapeUrlExpr = hasApiBaseUrl
  ? '`${API_BASE_URL}/' + plural + '`'
  : '`' + frontend.sync.shapeUrl + '/' + plural + '`';
-%>
export const <%= camelName %>Collection = createCollection(
	electricCollectionOptions({
		id: '<%= plural %>',
		shapeOptions: {
<% if (frontend.sync.useTableParam) { -%>
			url: new URL(
				'<%= frontend.sync.shapeUrl %>',
				window.location.origin,
			).toString(),
			params: {
				table: '<%= plural %>',
			},
<% } else { -%>
<% if (frontend.sync.wrapInUrlConstructor !== false) { -%>
			url: new URL(
				<%- shapeUrlExpr %>,
				window.location.origin,
			).toString(),
<% } else { -%>
			url: <%- shapeUrlExpr %>,
<% } -%>
<% } -%>
<% if (frontend.auth.function) { -%>
			headers: {
				Authorization: <%= frontend.auth.function %>(),
			},
<% } -%>
			parser: {
<% Object.entries(frontend.parsers).forEach(([type, fn]) => { -%>
				<%- type %>: <%- fn %>,
<% }); -%>
			},
<% if (frontend.sync.columnMapper) { -%>
<% if (frontend.sync.columnMapperNeedsCall !== false) { -%>
			columnMapper: <%= frontend.sync.columnMapper %>(),
<% } else { -%>
			columnMapper: <%= frontend.sync.columnMapper %>,
<% } -%>
<% } -%>
		},
<% const schemaPrefix = frontend.collections?.schemaPrefix ?? 'schema.'; -%>
		schema: <%= schemaPrefix %><%= camelName %>Schema,
		getKey: (item) => item.id,
	}),
);
<% } -%>
