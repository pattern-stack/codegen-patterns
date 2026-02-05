---
to: "<%= generate.schemaServer ? locations.dbSchemaServer.path : '' %>"
inject: true
after: "import {"
skip_if: "// Codegen imports managed"
---
<% if (generate.schemaServer) { -%>
 <%= drizzleImports.join(', ') %>, // Codegen imports managed
<% } -%>
