
import { z } from 'zod';
import { UpdateToteSchema } from '../../totes/dto/update-tote.dto';

// RFC-0006 §5: the base's update is the owner of every base field; this child extends it with its own fields, each
// optional and without a default, so a PATCH leaves an omitted field as it is (ZOD-1a).
export const UpdateBinSchema = UpdateToteSchema.extend({
  label: z.string().optional(),
  sealed: z.boolean().optional(),
})
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { label: 'Example label', sealed: true } });

export type UpdateBinDto = z.infer<typeof UpdateBinSchema>;
