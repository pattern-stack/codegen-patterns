---
to: "<%= frontendEnabled ? (generate.collections ? `${locations.frontendCollections.path}/collections.ts` : '') : '' %>"
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
// REST list endpoint for 'api' sync mode
const apiUrlExpr = hasApiBaseUrl
  ? '`${API_BASE_URL}/' + plural + '`'
  : '`' + frontend.sync.apiUrl + '/' + plural + '`';
const schemaPrefix = frontend.collections?.schemaPrefix ?? 'schema.';
-%>
<% if (frontend.sync.mode === 'api') { -%>
export const <%= camelName %>Collection = createCollection(
	queryCollectionOptions({
		id: '<%= plural %>',
		queryKey: ['<%= plural %>'],
		queryClient,
		queryFn: async () => {
			const res = await fetch(<%- apiUrlExpr %><% if (frontend.auth.function) { %>, {
				headers: { Authorization: <%= frontend.auth.function %>() },
			}<% } %>);
			if (!res.ok) {
				throw new Error(`GET <%= plural %> → ${res.status} ${res.statusText}`);
			}
			return res.json();
		},
		getKey: (item) => item.id,
		schema: <%= schemaPrefix %><%= camelName %>Schema,
	}),
);
<% } else { -%>
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
		schema: <%= schemaPrefix %><%= camelName %>Schema,
		getKey: (item) => item.id,
	}),
);
<% } -%>
<% } -%>
