
import { z } from 'zod';

export const ShipmentOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['air', 'sea']),
  weight: z.number().int(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', kind: 'air', weight: 1 } });

export type ShipmentOutputDto = z.infer<typeof ShipmentOutputSchema>;
