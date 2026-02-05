---
to: "<%= generate.schemaClient ? locations.dbSchemaClient.path : '' %>"
inject: true
after: "import {"
skip_if: "// Codegen imports managed"
---
<% if (generate.schemaClient) { -%>
 <%= drizzleImports.join(', ') %>, // Codegen imports managed
<% } -%>
