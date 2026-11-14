
import { z } from 'zod';

export const UserOutputSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
});

export type UserOutputDto = z.infer<typeof UserOutputSchema>;
