
import { z } from 'zod';

export const TaskOutputSchema = z.object({
  id: z.guid(),
  projectId: z.guid(),
  title: z.string(),
});

export type TaskOutputDto = z.infer<typeof TaskOutputSchema>;
