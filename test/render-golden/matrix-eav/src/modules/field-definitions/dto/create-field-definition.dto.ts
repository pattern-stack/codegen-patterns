
import { z } from 'zod';

export const CreateFieldDefinitionSchema = z.object({
  entityType: z.string(),
  key: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { entityType: 'Example entity type', key: 'Example key' } });

export type CreateFieldDefinitionDto = z.infer<typeof CreateFieldDefinitionSchema>;
