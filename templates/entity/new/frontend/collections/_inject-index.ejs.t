---
to: "<%= generate.collectionsIndex ? `${locations.frontendCollections.path}/index.ts` : '' %>"
inject: true
after: "// Generated entity collections"
skip_if: "from './collections'"
---
<% if (generate.collectionsIndex) { -%>
export * from './collections';
<% } -%>
