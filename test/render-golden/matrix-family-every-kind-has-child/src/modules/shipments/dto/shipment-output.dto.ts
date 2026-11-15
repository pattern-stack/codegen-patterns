
import { z } from 'zod';

export const ShipmentOutputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['air', 'sea']),
  weight: z.number().int(),
});

export type ShipmentOutputDto = z.infer<typeof ShipmentOutputSchema>;
