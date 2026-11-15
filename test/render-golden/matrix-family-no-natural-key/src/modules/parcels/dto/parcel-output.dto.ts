
import { z } from 'zod';

export const ParcelOutputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['crate', 'loose']),
  weight: z.number().int(),
});

export type ParcelOutputDto = z.infer<typeof ParcelOutputSchema>;
