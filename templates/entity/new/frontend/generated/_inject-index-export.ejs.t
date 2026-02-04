---
to: apps/frontend/src/generated/index.ts
inject: true
skip_if: "from './<%= name %>'"
after: "// Entity exports"
---
export * from './<%= name %>';
