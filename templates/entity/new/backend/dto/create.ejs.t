---
to: "<%= outputPaths.createDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
<% if (dtoExamples.importsExampleOf.create) { -%>
import { exampleOf } from '<%= openApiImport %>';
<% } -%>
<% if (familyChild) { -%>
import { <%= familyChild.baseCreateSchema %> } from '<%= familyChild.baseCreateImportPath %>';
<% } -%>

<%_ const _in = familyChild ? '    ' : '  '; _%>
<% if (familyChild) { -%>
// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('<%= familyChild.as %>') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const <%= classNames.createSchema %> = <%= familyChild.baseCreateSchema %>
  .omit({ <%= familyChild.discriminatorProp %>: true })
  .extend({
<% } else { -%>
export const <%= classNames.createSchema %> = z.object({
<% } -%>
<%_ createFkFields.forEach(fk => { _%>
<%= _in %><%= fk.camelName %>: <%- fk.zodChainCreate %>,
<%_ }) _%>
<%_ createDtoFields.forEach(field => { _%>
<%= _in %><%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
<% if (familyChild) { -%>
  })
<% } else { -%>
})
<% } -%>
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: <%- dtoExamples.create %> });

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
