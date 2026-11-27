
import { z } from 'zod';
import { CreateToteSchema } from './create-tote.dto';

// RFC-0006 §4.1: a row does not change kind, so the update takes no `kind`; one in a body is stripped.
export const UpdateToteSchema = CreateToteSchema.omit({ kind: true }).partial().extend({
  // A PATCH leaves an omitted field as it is: these restate the create schema's defaulted fields without the default
  // (ZOD-1a).
  fragile: z.boolean().optional(),
})
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { fragile: false } });

export type UpdateToteDto = z.infer<typeof UpdateToteSchema>;
