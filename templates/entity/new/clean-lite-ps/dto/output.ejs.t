---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.outputDto : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { z } from 'zod';

export const <%= classNames.outputSchema %> = z.object({
  id: z.string().uuid(),
<%_ clpBelongsToFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainOutput %>,
<%_ }) _%>
<%_ clpOutputDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainOutput %>,
<%_ }) _%>
<%_ if (hasTimestamps) { _%>
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
<%_ } _%>
<%_ if (hasSoftDelete) { _%>
  deletedAt: z.coerce.date().nullable(),
<%_ } _%>
});

export type <%= classNames.outputDto %> = z.infer<typeof <%= classNames.outputSchema %>>;
