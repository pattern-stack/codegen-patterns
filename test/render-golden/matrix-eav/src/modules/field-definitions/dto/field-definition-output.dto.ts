
import { z } from 'zod';

export const FieldDefinitionOutputSchema = z.object({
  id: z.guid(),
  entityType: z.string(),
  key: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FieldDefinitionOutputDto = z.infer<typeof FieldDefinitionOutputSchema>;
