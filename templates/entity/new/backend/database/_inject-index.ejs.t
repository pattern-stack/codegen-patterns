---
to: "<%= generate.drizzleSchema ? `${basePaths.backendSrc}/${backendLayers.drizzle}/index.ts` : '' %>"
inject: true
append: true
skip_if: <%= plural %>.schema
---
export * from './<%= plural %>.schema';
