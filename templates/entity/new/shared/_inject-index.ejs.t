---
to: packages/db/src/entities/index.ts
inject: true
after: "// codegen:exports"
skip_if: "from './<%= name %>'"
---
export * from './<%= name %>';
