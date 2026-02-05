---
to: "<%= generate.collections ? `${locations.frontendCollections.path}/collections.ts` : '' %>"
inject: true
append: true
skip_if: "// Codegen collections"
---
<% if (generate.collections) { -%>

// Codegen collections
<% } -%>
