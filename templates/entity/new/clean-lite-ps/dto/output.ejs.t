---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.outputDto : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';

export const <%= classNames.outputSchema %> = z.object({
  id: z.string().uuid(),
<%_ clpBelongsToFkFields.forEach(fk => { _%>
  <%= fk.camelName %>: <%- fk.zodChainOutput %>,
<%_ }) _%>
<%_ clpOutputDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainOutput %>,
<%_ }) _%>
<%_ if (hasExternalIdTracking) { _%>
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

export type <%= classNames.outputDto %> = z.infer<typeof <%= classNames.outputSchema %>>;
