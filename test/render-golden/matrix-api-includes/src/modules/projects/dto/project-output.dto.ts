
import { z } from 'zod';

export const ProjectOutputSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
});

export type ProjectOutputDto = z.infer<typeof ProjectOutputSchema>;
