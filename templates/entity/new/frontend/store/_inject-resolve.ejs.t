---
to: apps/frontend/src/lib/store/index.ts
inject: true
after: "resolve: \\{"
skip_if: "<%= singularCamelName %>:"
---
    <%= singularCamelName %>: (id: string | null | undefined) =>
      id ? <%= collectionVarName %>.get(id) : undefined,
