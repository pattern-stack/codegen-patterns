---
to: <%= locations.frontendStore.path %>/index.ts
inject: true
after: "entities: \\{"
skip_if: "<%= plural %>: <%= camelName %>Hooks"
---
    <%= plural %>: <%= camelName %>Hooks,
