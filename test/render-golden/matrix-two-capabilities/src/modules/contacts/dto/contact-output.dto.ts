
import { z } from 'zod';

export const ContactOutputSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
});

export type ContactOutputDto = z.infer<typeof ContactOutputSchema>;
