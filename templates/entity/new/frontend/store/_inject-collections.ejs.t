---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "collections: \\{"
skip_if: "<%= plural %>: <%= collectionVarName %>[^\\.]"
---
<% if (generate.hooks) { -%>
    <%= plural %>: <%= collectionVarName %>,
<% } -%>
