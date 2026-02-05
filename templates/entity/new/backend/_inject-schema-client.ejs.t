---
to: "<%= generate.schemaClient ? locations.dbSchemaClient.path : '' %>"
inject: true
after: "// Codegen exports"
skip_if: <%= camelName %>Schema
---
<% if (generate.schemaClient) { -%>
<%
const typeName = generate.typeNaming === 'plain' ? className : `${className}Entity`;
-%>
export const <%= camelName %>Schema = createSelectSchema(<%= plural %>);
export type <%= typeName %> = z.infer<typeof <%= camelName %>Schema>;
<% } -%>
