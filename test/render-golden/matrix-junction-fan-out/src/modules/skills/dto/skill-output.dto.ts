
import { z } from 'zod';

export const SkillOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
});

export type SkillOutputDto = z.infer<typeof SkillOutputSchema>;
