---
to: "<%= outputPaths.createDto %>"
force: true
---
import { z } from 'zod';
<%_ if (hasTypes) { _%>
import { <%= typeEnumName %> } from '../<%= name %>.entity';
<%_ } _%>

export const <%= classNames.createSchema %> = z.object({
  // FK endpoints (required)
  <%= fromColumnCamel %>: z.string().uuid(),
  <%= toColumnCamel %>: z.string().uuid(),
<%_ if (hasTypes) { _%>

  // Relationship type (required)
  type: z.enum(<%= typeEnumName %>.enumValues),
<%_ } _%>
<%_ if (temporal) { _%>

  // Temporal fields (optional on create)
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
  isCurrent: z.boolean().default(true),
<%_ } _%>
<%_ if (sourced) { _%>

  // Source tracking (optional on create)
  source: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
<%_ } _%>
<%_ if (createDtoFields.length > 0) { _%>

  // Custom fields
<%_ createDtoFields.forEach(field => { _%>
  <%= field.camelName %>: <%- field.zodChainCreate %>,
<%_ }) _%>
<%_ } _%>
});

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
