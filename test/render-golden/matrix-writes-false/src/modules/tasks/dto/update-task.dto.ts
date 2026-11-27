
import { z } from 'zod';
import { CreateTaskSchema } from './create-task.dto';

export const UpdateTaskSchema = CreateTaskSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { title: 'Example title' } });

export type UpdateTaskDto = z.infer<typeof UpdateTaskSchema>;
