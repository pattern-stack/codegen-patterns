
import { z } from 'zod';

export const CreateTaskSchema = z.object({
  projectId: z.guid().meta({ description: 'The id of an existing project (GET /projects lists them). The example is a placeholder: replace it with a real id before sending.' }),
  title: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { projectId: '00000000-0000-4000-8000-000000000001', title: 'Example title' } });

export type CreateTaskDto = z.infer<typeof CreateTaskSchema>;
