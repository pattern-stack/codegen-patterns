
import { z } from 'zod';
import { CreateTaskSchema } from './create-task.dto';

export const UpdateTaskSchema = CreateTaskSchema.partial();

export type UpdateTaskDto = z.infer<typeof UpdateTaskSchema>;
