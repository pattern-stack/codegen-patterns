
import { z } from 'zod';

export const ProjectOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  name: z.string(),
});

export type ProjectOutputDto = z.infer<typeof ProjectOutputSchema>;
