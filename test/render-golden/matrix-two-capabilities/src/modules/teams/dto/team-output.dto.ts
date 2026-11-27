
import { z } from 'zod';

export const TeamOutputSchema = z.object({
  id: z.guid(),
  leadContactId: z.guid(),
  name: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type TeamOutputDto = z.infer<typeof TeamOutputSchema>;
