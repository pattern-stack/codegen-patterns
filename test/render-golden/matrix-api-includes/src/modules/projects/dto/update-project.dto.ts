
import { z } from 'zod';
import { CreateProjectSchema } from './create-project.dto';

export const UpdateProjectSchema = CreateProjectSchema.partial();

export type UpdateProjectDto = z.infer<typeof UpdateProjectSchema>;
