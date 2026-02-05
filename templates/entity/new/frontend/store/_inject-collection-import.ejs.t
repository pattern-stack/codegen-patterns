---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "// Collection imports"
skip_if: "from '<%= locations.frontendCollections.import %>/collections'"
---
<% if (generate.hooks) { -%>
import { <%= collectionVarName %> } from '<%= locations.frontendCollections.import %>/collections';
<% } -%>
