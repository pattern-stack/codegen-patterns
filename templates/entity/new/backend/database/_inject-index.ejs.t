---
to: <%= basePaths.backendSrc %>/infrastructure/persistence/drizzle/index.ts
inject: true
append: true
skip_if: <%= plural %>.schema
---
export * from './<%= plural %>.schema';
