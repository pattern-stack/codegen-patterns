---
to: "<%= outputPaths.updateDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
<% if (familyChild) { -%>
import { <%= familyChild.baseUpdateSchema %> } from '<%= familyChild.baseUpdateImportPath %>';
<% } else { -%>
import { <%= classNames.createSchema %> } from './create-<%= entityFileStem %>.dto';
<% } -%>

<% if (familyChild) { -%>
// RFC-0006 §5: the base's update is the owner of every base field; this child extends it with its own fields, each
// optional and without a default, so a PATCH leaves an omitted field as it is (ZOD-1a).
export const <%= classNames.updateSchema %> = <%= familyChild.baseUpdateSchema %>.extend({
<%_ createFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainUpdate %>,
<%_ }) _%>
<%_ createDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainUpdate %>,
<%_ }) _%>
});
<% } else { -%>
<% if (familyBase) { -%>
// RFC-0006 §4.1: a row does not change kind, so the update takes no `<%= familyBase.discriminatorProp %>`; one in a body is stripped.
<% } -%>
export const <%= classNames.updateSchema %> = <%= classNames.createSchema %><% if (familyBase) { %>.omit({ <%= familyBase.discriminatorProp %>: true })<% } %>.partial()<% if (updateDefaultOverrides.length === 0) { %>;<% } else { %>.extend({
  // A PATCH leaves an omitted field as it is: these restate the create schema's defaulted fields without the default
  // (ZOD-1a).
<%_ updateDefaultOverrides.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainUpdate %>,
<%_ }) _%>
});<% } %>
<% } -%>

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
