
import { z } from 'zod';

export const CreateProjectSchema = z.object({
  accountId: z.guid(),
  name: z.string(),
});

export type CreateProjectDto = z.infer<typeof CreateProjectSchema>;
