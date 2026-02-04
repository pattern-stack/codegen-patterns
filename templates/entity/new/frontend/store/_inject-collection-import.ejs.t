---
to: <%= locations.frontendStore.path %>/index.ts
inject: true
after: "// Collection imports"
skip_if: "from '<%= locations.frontendCollections.import %>/<%= name %>'"
---
import { <%= collectionVarName %> } from '<%= locations.frontendCollections.import %>/<%= name %>';
