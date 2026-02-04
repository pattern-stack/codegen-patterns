---
to: apps/frontend/src/generated/index.ts
inject: true
skip_if: "import { <%= camelName %> }"
after: "// Entity registry"
---
import { <%= camelName %> } from './<%= name %>';
