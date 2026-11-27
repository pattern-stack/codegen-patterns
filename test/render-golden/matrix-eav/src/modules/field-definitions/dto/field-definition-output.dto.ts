
import { z } from 'zod';

export const FieldDefinitionOutputSchema = z.object({
  id: z.guid(),
  entityType: z.string(),
  key: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', entityType: 'Example entity type', key: 'Example key', createdAt: '2026-01-15T09:30:00.000Z', updatedAt: '2026-01-15T09:30:00.000Z' } });

export type FieldDefinitionOutputDto = z.infer<typeof FieldDefinitionOutputSchema>;
