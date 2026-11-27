
import { z } from 'zod';

export const TaskOutputSchema = z.object({
  id: z.guid(),
  projectId: z.guid(),
  title: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000001', title: 'Example title' } });

export type TaskOutputDto = z.infer<typeof TaskOutputSchema>;
