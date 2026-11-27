
import { z } from 'zod';

export const ParcelOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['crate', 'loose']),
  weight: z.number().int(),
});

export type ParcelOutputDto = z.infer<typeof ParcelOutputSchema>;
