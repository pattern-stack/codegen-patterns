---
to: <%= locations.frontendStore.path %>/index.ts
inject: true
after: "// Entity hooks"
skip_if: "from './entities/<%= name %>'"
---
import { <%= camelName %>Hooks } from './entities/<%= name %>';
