
import { z } from 'zod';

export const TaskOutputSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
});

export type TaskOutputDto = z.infer<typeof TaskOutputSchema>;
