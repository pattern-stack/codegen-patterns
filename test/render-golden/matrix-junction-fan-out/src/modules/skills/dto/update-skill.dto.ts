
import { z } from 'zod';
import { CreateSkillSchema } from './create-skill.dto';

export const UpdateSkillSchema = CreateSkillSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { label: 'Example label' } });

export type UpdateSkillDto = z.infer<typeof UpdateSkillSchema>;
