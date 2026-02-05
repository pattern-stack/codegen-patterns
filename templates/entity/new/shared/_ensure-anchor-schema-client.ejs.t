---
to: "<%= generate.schemaClient ? locations.dbSchemaClient.path : '' %>"
inject: true
append: true
skip_if: "// Codegen tables"
---
<% if (generate.schemaClient) { -%>

// Codegen tables

// Codegen exports
<% } -%>
