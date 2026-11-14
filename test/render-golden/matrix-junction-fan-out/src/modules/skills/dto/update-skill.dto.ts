
import { z } from 'zod';
import { CreateSkillSchema } from './create-skill.dto';

export const UpdateSkillSchema = CreateSkillSchema.partial();

export type UpdateSkillDto = z.infer<typeof UpdateSkillSchema>;
