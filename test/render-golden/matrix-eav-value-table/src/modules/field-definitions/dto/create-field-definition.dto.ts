
import { z } from 'zod';

export const CreateFieldDefinitionSchema = z.object({
  entityType: z.string(),
  key: z.string(),
});

export type CreateFieldDefinitionDto = z.infer<typeof CreateFieldDefinitionSchema>;
