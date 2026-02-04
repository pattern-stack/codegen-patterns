---
to: apps/frontend/src/lib/store/index.ts
inject: true
after: "// Lookup entries"
skip_if: "<%= plural %>: <%= collectionVarName %>\\.state"
---
      <%= plural %>: <%= collectionVarName %>.state,
