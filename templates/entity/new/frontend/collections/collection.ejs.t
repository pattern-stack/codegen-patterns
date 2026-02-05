---
to: "<%= generate.collections ? `${locations.frontendCollections.path}/collections.ts` : '' %>"
inject: true
after: "// Codegen collections"
skip_if: <%= camelName %>Collection
---
<% if (generate.collections) { -%>
<%
// Determine the base URL expression
const hasApiBaseUrl = !!frontend.sync.apiBaseUrlImport;
const baseUrlExpr = hasApiBaseUrl
  ? 'API_BASE_URL'
  : "typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'";
-%>
export const <%= camelName %>Collection = createCollection(
	electricCollectionOptions({
		id: '<%= plural %>',
		shapeOptions: {
<% if (frontend.sync.useTableParam) { -%>
			url: new URL(
				'<%= frontend.sync.shapeUrl %>',
				<%= baseUrlExpr %>,
			).toString(),
			params: {
				table: '<%= plural %>',
			},
<% } else { -%>
<% if (frontend.sync.wrapInUrlConstructor !== false) { -%>
			url: new URL(
				`<%= frontend.sync.shapeUrl %>/<%= plural %>`,
				<%= baseUrlExpr %>,
			).toString(),
<% } else { -%>
			url: `<%= frontend.sync.shapeUrl %>/<%= plural %>`,
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
		schema: schema.<%= camelName %>Schema,
		getKey: (item) => item.id,
	}),
);
<% } -%>
