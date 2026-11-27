
import { z } from 'zod';
import { ShipmentOutputSchema } from '../../shipments/dto/shipment-output.dto';

// RFC-0006 §5: the columns THIS table owns, alone. `ShipmentOfKindSchema` nests it under the kind key.
export const AirFreightOwnOutputSchema = z.object({
  id: z.guid(),
  flight: z.string(),
});

// The flat shape every HTTP read and write of a air_freight returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const AirFreightOutputSchema = ShipmentOutputSchema.extend({
  kind: z.literal('air'),
  ...AirFreightOwnOutputSchema.omit({ id: true }).shape,
});

export type AirFreightOutputDto = z.infer<typeof AirFreightOutputSchema>;
