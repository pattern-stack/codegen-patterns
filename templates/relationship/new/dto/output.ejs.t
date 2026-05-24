---
to: "<%= outputPaths.outputDto %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';

export const <%= classNames.outputSchema %> = z.object({
  id: z.string().uuid(),

  // FK endpoints
  <%= fromColumnCamel %>: z.string().uuid(),
  <%= toColumnCamel %>: z.string().uuid(),
<%_ if (hasTypes) { _%>

  // Type
  type: z.string(),
<%_ } _%>
<%_ if (temporal) { _%>

  // Temporal
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  isCurrent: z.boolean().nullable(),
<%_ } _%>
<%_ if (sourced) { _%>

  // Source tracking
  source: z.string().nullable(),
  confidence: z.number().nullable(),
<%_ } _%>
<%_ if (outputDtoFields.length > 0) { _%>

  // Custom fields
<%_ outputDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainOutput %>,
<%_ }) _%>
<%_ } _%>

  // Timestamps
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type <%= classNames.outputDto %> = z.infer<typeof <%= classNames.outputSchema %>>;
