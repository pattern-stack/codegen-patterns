---
to: <%= locations.backendConstants.path %>/tokens.ts
inject: true
append: true
skip_if: <%= repositoryToken %>
---
export const <%= repositoryToken %> = Symbol('<%= repositoryToken %>');
