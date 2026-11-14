
import { z } from 'zod';

export const CreateAccountSchema = z.object({
  name: z.string(),
});

export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;
