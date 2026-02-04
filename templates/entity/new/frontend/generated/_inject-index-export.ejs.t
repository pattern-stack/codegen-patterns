---
to: <%= locations.frontendGenerated.path %>/index.ts
inject: true
skip_if: "from './<%= name %>'"
after: "// Entity exports"
---
export * from './<%= name %>';
