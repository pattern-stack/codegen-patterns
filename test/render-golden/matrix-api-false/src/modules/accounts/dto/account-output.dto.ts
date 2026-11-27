
import { z } from 'zod';

export const AccountOutputSchema = z.object({
  id: z.guid(),
  name: z.string(),
});

export type AccountOutputDto = z.infer<typeof AccountOutputSchema>;
