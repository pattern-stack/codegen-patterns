
import { z } from 'zod';

export const ToteOutputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['bin', 'loose']),
  fragile: z.boolean().nullable(),
});

export type ToteOutputDto = z.infer<typeof ToteOutputSchema>;
