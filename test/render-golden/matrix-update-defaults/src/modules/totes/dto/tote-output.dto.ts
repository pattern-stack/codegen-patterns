
import { z } from 'zod';

export const ToteOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['bin', 'loose']),
  fragile: z.boolean().nullable(),
});

export type ToteOutputDto = z.infer<typeof ToteOutputSchema>;
