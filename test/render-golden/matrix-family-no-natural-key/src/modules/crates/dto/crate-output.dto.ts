
import { z } from 'zod';

export const CrateOutputSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
});

export type CrateOutputDto = z.infer<typeof CrateOutputSchema>;
