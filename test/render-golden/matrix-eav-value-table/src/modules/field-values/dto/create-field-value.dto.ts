
import { z } from 'zod';

export const CreateFieldValueSchema = z.object({
  entityType: z.string(),
  entityId: z.guid(),
  fieldDefinitionId: z.guid(),
  userId: z.guid(),
  value: z.unknown(),
});

export type CreateFieldValueDto = z.infer<typeof CreateFieldValueSchema>;
