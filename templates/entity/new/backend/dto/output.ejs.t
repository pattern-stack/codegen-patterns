---
to: "<%= outputPaths.outputDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
<% if (familyChild) { -%>
import { <%= familyChild.baseOutputSchema %> } from '<%= familyChild.baseOutputImportPath %>';
<% } -%>

<% if (familyChild) { -%>
// RFC-0006 §5: the columns THIS table owns, alone. `<%= familyChild.baseClass %>OfKindSchema` nests it under the kind key.
<% } -%>
export const <%= familyChild ? classNames.ownOutputSchema : classNames.outputSchema %> = z.object({
  id: z.string().uuid(),
<%_ belongsToFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainOutput %>,
<%_ }) _%>
<%_ outputDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainOutput %>,
<%_ }) _%>
<%_ if (ownsExternalIdColumns) { _%>
  // external_id_tracking behavior — external_id is the public cross-entity join
  // key (a referenced entity exposes it so consumers can join), so it rides the
  // output DTO read-only. provider / provider_metadata stay internal.
  externalId: z.string().nullable(),
<%_ } _%>
<%_ if (hasTimestamps) { _%>
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
<%_ } _%>
<%_ if (hasSoftDelete) { _%>
  deletedAt: z.coerce.date().nullable(),
<%_ } _%>
});
<% if (familyChild) { -%>

// The flat shape every HTTP read and write of a <%= entityName %> returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const <%= classNames.outputSchema %> = <%= familyChild.baseOutputSchema %>.extend({
  <%= familyChild.discriminatorProp %>: z.literal('<%= familyChild.as %>'),
  ...<%= classNames.ownOutputSchema %>.omit({ id: true }).shape,
});
<% } -%>

<%_ if (outputDtoHasUnknownKey) { _%>
// `Required<…>`: Zod 3 infers a `json` (`z.unknown()`) key as optional; the row
// has it required. Every other key here is required already.
export type <%= classNames.outputDto %> = globalThis.Required<z.infer<typeof <%= classNames.outputSchema %>>>;
<%_ } else { _%>
export type <%= classNames.outputDto %> = z.infer<typeof <%= classNames.outputSchema %>>;
<%_ } _%>
