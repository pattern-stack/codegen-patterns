
import { z } from 'zod';

export const SkillOutputSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
});

export type SkillOutputDto = z.infer<typeof SkillOutputSchema>;
