---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "// Entity hooks"
skip_if: "from './entities/<%= name %>'"
---
<% if (generate.hooks) { -%>
import { <%= camelName %>Hooks } from './entities/<%= name %>';
<% } -%>
