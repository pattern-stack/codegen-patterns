
import { z } from 'zod';

export const ShipmentOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['air', 'sea']),
  weight: z.number().int(),
});

export type ShipmentOutputDto = z.infer<typeof ShipmentOutputSchema>;
