---
inject: true
to: <%= locations.frontendEntities.path %>/index.ts
after: "// \\[CODEGEN:ENTITY_IMPORTS\\]"
skip_if: "from './<%= name %>'"
---
import { <%= plural %> } from './<%= name %>';
