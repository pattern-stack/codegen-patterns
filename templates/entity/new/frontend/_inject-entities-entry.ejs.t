---
inject: true
to: <%= locations.frontendEntities.path %>/index.ts
after: "// \\[CODEGEN:ENTITY_ENTRIES\\]"
skip_if: "<%= plural %>,"
---
  <%= plural %>,
