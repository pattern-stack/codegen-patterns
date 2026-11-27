
import { z } from 'zod';
import { UpdateShipmentSchema } from '../../shipments/dto/update-shipment.dto';

// RFC-0006 §5: the base's update is the owner of every base field; this child extends it with its own fields, each
// optional and without a default, so a PATCH leaves an omitted field as it is (ZOD-1a).
export const UpdateSeaFreightSchema = UpdateShipmentSchema.extend({
  vessel: z.string().optional(),
})
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { vessel: 'Example vessel' } });

export type UpdateSeaFreightDto = z.infer<typeof UpdateSeaFreightSchema>;
