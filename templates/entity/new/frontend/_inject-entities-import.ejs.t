---
inject: true
to: apps/frontend/src/lib/entities/index.ts
after: "// \\[CODEGEN:ENTITY_IMPORTS\\]"
skip_if: "from './<%= name %>'"
---
import { <%= plural %> } from './<%= name %>';
