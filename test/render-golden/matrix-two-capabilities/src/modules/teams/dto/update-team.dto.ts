
import { z } from 'zod';
import { CreateTeamSchema } from './create-team.dto';

export const UpdateTeamSchema = CreateTeamSchema.partial();

export type UpdateTeamDto = z.infer<typeof UpdateTeamSchema>;
