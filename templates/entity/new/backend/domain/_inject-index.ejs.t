---
to: <%= basePaths.backendSrc %>/domain/index.ts
inject: true
append: true
skip_if: <%= name %>
---
<% if (isNested) { -%>
export * from './<%= name %>';
<% } else { -%>
export * from './<%= name %>.entity';
export * from './<%= name %>.repository.interface';
<% } -%>
