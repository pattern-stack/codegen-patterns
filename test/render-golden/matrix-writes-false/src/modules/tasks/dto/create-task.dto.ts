
import { z } from 'zod';

export const CreateTaskSchema = z.object({
  projectId: z.guid(),
  title: z.string(),
});

export type CreateTaskDto = z.infer<typeof CreateTaskSchema>;
