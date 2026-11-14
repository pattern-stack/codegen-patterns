
import { z } from 'zod';

export const CreateSkillSchema = z.object({
  label: z.string(),
});

export type CreateSkillDto = z.infer<typeof CreateSkillSchema>;
