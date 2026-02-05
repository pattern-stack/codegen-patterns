---
to: "<%= generate.schemaServer ? locations.dbSchemaServer.path : '' %>"
inject: true
append: true
skip_if: "// Codegen tables"
---
<% if (generate.schemaServer) { -%>

// Codegen tables

// Codegen exports
<% } -%>
