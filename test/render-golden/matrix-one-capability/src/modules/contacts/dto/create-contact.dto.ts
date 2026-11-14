
import { z } from 'zod';

export const CreateContactSchema = z.object({
  email: z.string(),
});

export type CreateContactDto = z.infer<typeof CreateContactSchema>;
