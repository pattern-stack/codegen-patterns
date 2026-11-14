
import { z } from 'zod';

export const CreateProjectSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string(),
});

export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;
