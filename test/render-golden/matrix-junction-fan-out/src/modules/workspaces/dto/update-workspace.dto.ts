
import { z } from 'zod';
import { CreateWorkspaceSchema } from './create-workspace.dto';

export const UpdateWorkspaceSchema = CreateWorkspaceSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateWorkspaceDto = z.infer<typeof UpdateWorkspaceSchema>;
