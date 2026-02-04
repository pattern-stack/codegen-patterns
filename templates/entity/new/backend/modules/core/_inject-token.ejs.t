---
to: <%= basePaths.backendSrc %>/constants/tokens.ts
inject: true
after: "// Generated entity repository tokens"
skip_if: <%= repositoryToken %>
---
export const <%= repositoryToken %> = Symbol('<%= repositoryToken %>');
