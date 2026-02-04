---
to: <%= locations.frontendStore.path %>/index.ts
inject: true
after: "collections: \\{"
skip_if: "<%= plural %>: <%= collectionVarName %>[^\\.]"
---
    <%= plural %>: <%= collectionVarName %>,
