
import { z } from 'zod';

export const CreateShipmentSchema = z.object({
  kind: z.never(),
  weight: z.number().int(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { weight: 1 } });

export type CreateShipmentDto = z.infer<typeof CreateShipmentSchema>;
