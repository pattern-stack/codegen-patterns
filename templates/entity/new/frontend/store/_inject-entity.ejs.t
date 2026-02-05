---
to: "<%= generate.hooks ? `${locations.frontendStore.path}/index.ts` : '' %>"
inject: true
after: "entities: \\{"
skip_if: "<%= plural %>: <%= camelName %>Hooks"
---
<% if (generate.hooks) { -%>
    <%= plural %>: <%= camelName %>Hooks,
<% } -%>
