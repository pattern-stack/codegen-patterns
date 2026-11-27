
import { z } from 'zod';
import { CreateShelfSchema } from './create-shelf.dto';

export const UpdateShelfSchema = CreateShelfSchema.partial().extend({
  // A PATCH leaves an omitted field as it is: these restate the create schema's defaulted fields without the default
  // (ZOD-1a).
  active: z.boolean().optional(),
  archived: z.boolean().optional(),
})
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { label: 'Example label', active: true } });

export type UpdateShelfDto = z.infer<typeof UpdateShelfSchema>;
