
import { z } from 'zod';
import { CreateProjectSchema } from './create-project.dto';

export const UpdateProjectSchema = CreateProjectSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateProjectDto = z.infer<typeof UpdateProjectSchema>;
