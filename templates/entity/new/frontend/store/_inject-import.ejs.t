---
to: apps/frontend/src/lib/store/index.ts
inject: true
after: "// Entity hooks"
skip_if: "from './entities/<%= name %>'"
---
import { <%= camelName %>Hooks } from './entities/<%= name %>';
