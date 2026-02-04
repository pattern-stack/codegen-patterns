---
to: apps/frontend/src/lib/store/index.ts
inject: true
after: "// Collection imports"
skip_if: "from '@/lib/collections/<%= name %>'"
---
import { <%= collectionVarName %> } from '@/lib/collections/<%= name %>';
