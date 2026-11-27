
import { z } from 'zod';
import { CreateParcelSchema } from './create-parcel.dto';

// RFC-0006 §4.1: a row does not change kind, so the update takes no `kind`; one in a body is stripped.
export const UpdateParcelSchema = CreateParcelSchema.omit({ kind: true }).partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { weight: 1 } });

export type UpdateParcelDto = z.infer<typeof UpdateParcelSchema>;
