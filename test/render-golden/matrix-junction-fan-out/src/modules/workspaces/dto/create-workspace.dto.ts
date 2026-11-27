
import { z } from 'zod';

export const CreateWorkspaceSchema = z.object({
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceSchema>;
