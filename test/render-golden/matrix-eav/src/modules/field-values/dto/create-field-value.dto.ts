
import { z } from 'zod';

export const CreateFieldValueSchema = z.object({
  entityType: z.string(),
  entityId: z.string().uuid(),
  fieldDefinitionId: z.string().uuid(),
  userId: z.string().uuid(),
  value: z.unknown(),
});

export type CreateFieldValueDto = z.infer<typeof CreateFieldValueSchema>;
