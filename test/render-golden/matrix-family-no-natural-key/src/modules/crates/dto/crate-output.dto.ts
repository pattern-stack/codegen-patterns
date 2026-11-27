
import { z } from 'zod';
import { ParcelOutputSchema } from '../../parcels/dto/parcel-output.dto';

// RFC-0006 §5: the columns THIS table owns, alone. `ParcelOfKindSchema` nests it under the kind key.
export const CrateOwnOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
});

// The flat shape every HTTP read and write of a crate returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const CrateOutputSchema = ParcelOutputSchema.extend({
  kind: z.literal('crate'),
  ...CrateOwnOutputSchema.omit({ id: true }).shape,
});

export type CrateOutputDto = z.infer<typeof CrateOutputSchema>;
