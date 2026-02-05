---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "// Lookup entries"
skip_if: "<%= plural %>: <%= collectionVarName %>\\.state"
---
<% if (generate.hooks) { -%>
      <%= plural %>: <%= collectionVarName %>.state,
<% } -%>
