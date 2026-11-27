
import { z } from 'zod';
import { ShipmentOutputSchema } from '../../shipments/dto/shipment-output.dto';

// RFC-0006 §5: the columns THIS table owns, alone. `ShipmentOfKindSchema` nests it under the kind key.
export const SeaFreightOwnOutputSchema = z.object({
  id: z.guid(),
  vessel: z.string(),
});

// The flat shape every HTTP read and write of a sea_freight returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const SeaFreightOutputSchema = ShipmentOutputSchema.extend({
  kind: z.literal('sea'),
  ...SeaFreightOwnOutputSchema.omit({ id: true }).shape,
});

export type SeaFreightOutputDto = z.infer<typeof SeaFreightOutputSchema>;
