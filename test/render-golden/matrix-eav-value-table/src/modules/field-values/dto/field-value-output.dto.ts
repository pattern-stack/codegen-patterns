
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
});

export type FieldValueOutputDto = z.infer<typeof FieldValueOutputSchema>;
