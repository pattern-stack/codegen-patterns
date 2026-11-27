
import { z } from 'zod';

export const FieldValueOutputSchema = z.object({
  id: z.guid(),
  entityType: z.string(),
  entityId: z.guid(),
  fieldDefinitionId: z.guid(),
  userId: z.guid(),
  value: z.unknown(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', entityType: 'Example entity type', entityId: '00000000-0000-4000-8000-000000000001', fieldDefinitionId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000001', value: {}, createdAt: '2026-01-15T09:30:00.000Z', updatedAt: '2026-01-15T09:30:00.000Z' } });

export type FieldValueOutputDto = z.infer<typeof FieldValueOutputSchema>;
