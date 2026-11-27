
import { z } from 'zod';

export const CreateTeamSchema = z.object({
  leadContactId: z.guid(),
  name: z.string(),
});

export type CreateTeamDto = z.infer<typeof CreateTeamSchema>;
