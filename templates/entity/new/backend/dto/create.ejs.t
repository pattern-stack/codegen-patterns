---
to: "<%= outputPaths.createDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';

export const <%= classNames.createSchema %> = z.object({
<%_ belongsToFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainCreate %>,
<%_ }) _%>
<%_ createDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
});

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
