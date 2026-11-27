
import { z } from 'zod';

export const ProjectOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  name: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000001', name: 'Example name' } });

export type ProjectOutputDto = z.infer<typeof ProjectOutputSchema>;
