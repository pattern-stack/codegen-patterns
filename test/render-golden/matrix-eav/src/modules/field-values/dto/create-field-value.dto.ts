
import { z } from 'zod';

export const CreateFieldValueSchema = z.object({
  entityType: z.string(),
  entityId: z.guid(),
  fieldDefinitionId: z.guid(),
  userId: z.guid(),
  value: z.unknown(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { entityType: 'Example entity type', entityId: '00000000-0000-4000-8000-000000000001', fieldDefinitionId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000001', value: {} } });

export type CreateFieldValueDto = z.infer<typeof CreateFieldValueSchema>;
