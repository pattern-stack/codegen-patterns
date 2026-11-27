
import { z } from 'zod';
import { CreateFieldValueSchema } from './create-field-value.dto';

export const UpdateFieldValueSchema = CreateFieldValueSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { entityType: 'Example entity type' } });

export type UpdateFieldValueDto = z.infer<typeof UpdateFieldValueSchema>;
