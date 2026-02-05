---
to: "<%= generate.collections && !frontend.collections?.schemaPrefix ? `${locations.frontendCollections.path}/collections.ts` : '' %>"
inject: true
after: "// Codegen schema imports"
skip_if: <%= camelName %>Schema
---
<% if (generate.collections && !frontend.collections?.schemaPrefix) { -%>
	<%= camelName %>Schema,
<% } -%>
