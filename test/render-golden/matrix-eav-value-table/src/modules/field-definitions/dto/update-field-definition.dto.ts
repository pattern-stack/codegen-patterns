
import { z } from 'zod';
import { CreateFieldDefinitionSchema } from './create-field-definition.dto';

export const UpdateFieldDefinitionSchema = CreateFieldDefinitionSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { entityType: 'Example entity type' } });

export type UpdateFieldDefinitionDto = z.infer<typeof UpdateFieldDefinitionSchema>;
