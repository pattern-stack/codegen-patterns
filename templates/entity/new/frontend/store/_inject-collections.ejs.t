---
to: apps/frontend/src/lib/store/index.ts
inject: true
after: "collections: \\{"
skip_if: "<%= plural %>: <%= collectionVarName %>[^\\.]"
---
    <%= plural %>: <%= collectionVarName %>,
