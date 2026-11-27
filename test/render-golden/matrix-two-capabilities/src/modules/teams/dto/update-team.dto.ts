
import { z } from 'zod';
import { CreateTeamSchema } from './create-team.dto';

export const UpdateTeamSchema = CreateTeamSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateTeamDto = z.infer<typeof UpdateTeamSchema>;
