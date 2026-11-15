---
to: "<%= outputPaths.createDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
<% if (familyChild) { -%>
import { <%= familyChild.baseCreateSchema %> } from '<%= familyChild.baseCreateImportPath %>';
<% } -%>

<% if (familyChild) { -%>
// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('<%= familyChild.as %>') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const <%= classNames.createSchema %> = <%= familyChild.baseCreateSchema %>
  .omit({ <%= familyChild.discriminatorProp %>: true })
  .extend({
<%_ createFkFields.forEach(fk => { _%>
    <%= fk.camelName %>: <%- fk.zodChainCreate %>,
<%_ }) _%>
<%_ createDtoFields.forEach(field => { _%>
    <%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
  });
<% } else { -%>
export const <%= classNames.createSchema %> = z.object({
<%_ createFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainCreate %>,
<%_ }) _%>
<%_ createDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
});
<% } -%>

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
