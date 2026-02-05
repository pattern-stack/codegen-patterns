---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "resolve: \\{"
skip_if: "<%= singularCamelName %>:"
---
<% if (generate.hooks) { -%>
    <%= singularCamelName %>: (id: string | null | undefined) =>
      id ? <%= collectionVarName %>.get(id) : undefined,
<% } -%>
