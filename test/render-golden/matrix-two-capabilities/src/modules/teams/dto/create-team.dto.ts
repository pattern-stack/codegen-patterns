
import { z } from 'zod';

export const CreateTeamSchema = z.object({
  leadContactId: z.string().uuid(),
  name: z.string(),
});

export type CreateTeamDto = z.infer<typeof CreateTeamSchema>;
