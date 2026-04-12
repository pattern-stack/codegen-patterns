---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.createDto : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { z } from 'zod';

export const <%= classNames.createSchema %> = z.object({
<%_ clpBelongsToFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainCreate %>,
<%_ }) _%>
<%_ clpCreateDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
});

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
