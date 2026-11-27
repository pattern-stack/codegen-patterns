
import { z } from 'zod';
import { exampleOf } from '@shared/openapi';
import { ParcelOutputSchema } from '../../parcels/dto/parcel-output.dto';

// RFC-0006 §5: the columns THIS table owns, alone. `ParcelOfKindSchema` nests it under the kind key.
export const CrateOwnOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', label: 'Example label' } });

// The flat shape every HTTP read and write of a crate returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const CrateOutputSchema = ParcelOutputSchema.extend({
  kind: z.literal('crate'),
  ...CrateOwnOutputSchema.omit({ id: true }).shape,
}).meta({ example: { ...exampleOf(ParcelOutputSchema), kind: 'crate', ...exampleOf(CrateOwnOutputSchema, 'id') } });

export type CrateOutputDto = z.infer<typeof CrateOutputSchema>;
