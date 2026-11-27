
import { z } from 'zod';
import { exampleOf } from '@shared/openapi';
import { CreateShipmentSchema } from '../../shipments/dto/create-shipment.dto';

// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('sea') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const CreateSeaFreightSchema = CreateShipmentSchema
  .omit({ kind: true })
  .extend({
    vessel: z.string(),
  })
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { ...exampleOf(CreateShipmentSchema, 'kind'), vessel: 'Example vessel' } });

export type CreateSeaFreightDto = z.infer<typeof CreateSeaFreightSchema>;
