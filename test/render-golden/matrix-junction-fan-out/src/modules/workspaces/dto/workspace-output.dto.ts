
import { z } from 'zod';

export const WorkspaceOutputSchema = z.object({
  id: z.guid(),
  name: z.string(),
});

export type WorkspaceOutputDto = z.infer<typeof WorkspaceOutputSchema>;
