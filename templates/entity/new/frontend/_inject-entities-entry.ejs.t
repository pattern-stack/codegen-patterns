---
inject: true
to: apps/frontend/src/lib/entities/index.ts
after: "// \\[CODEGEN:ENTITY_ENTRIES\\]"
skip_if: "<%= plural %>,"
---
  <%= plural %>,
