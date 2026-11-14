
import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  name: z.string(),
});

export type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceSchema>;
