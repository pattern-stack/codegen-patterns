---
to: "<%= outputPaths.updateDto %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= entityFileStem %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial()<% if (updateDefaultOverrides.length === 0) { %>;<% } else { %>.extend({
  // A PATCH leaves an omitted field as it is: these restate the create schema's defaulted fields without the default
  // (ZOD-1a).
<%_ updateDefaultOverrides.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainUpdate %>,
<%_ }) _%>
});<% } %>

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
