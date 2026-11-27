
import { z } from 'zod';

export const CreateSkillSchema = z.object({
  label: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { label: 'Example label' } });

export type CreateSkillDto = z.infer<typeof CreateSkillSchema>;
