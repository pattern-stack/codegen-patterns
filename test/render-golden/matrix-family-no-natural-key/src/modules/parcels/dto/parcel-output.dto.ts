
import { z } from 'zod';

export const ParcelOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['crate', 'loose']),
  weight: z.number().int(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', kind: 'crate', weight: 1 } });

export type ParcelOutputDto = z.infer<typeof ParcelOutputSchema>;
