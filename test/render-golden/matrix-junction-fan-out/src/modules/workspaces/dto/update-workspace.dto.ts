
import { z } from 'zod';
import { CreateWorkspaceSchema } from './create-workspace.dto';

export const UpdateWorkspaceSchema = CreateWorkspaceSchema.partial();

export type UpdateWorkspaceDto = z.infer<typeof UpdateWorkspaceSchema>;
