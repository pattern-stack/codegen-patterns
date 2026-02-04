---
to: <%= locations.frontendCollections.path %>/index.ts
inject: true
after: "// Generated entity collections"
skip_if: <%= camelName %>Collection
---
export { <%= camelName %>Collection } from './<%= name %>';
