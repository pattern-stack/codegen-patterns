
import { z } from 'zod';

export const ContactOutputSchema = z.object({
  id: z.guid(),
  email: z.string(),
});

export type ContactOutputDto = z.infer<typeof ContactOutputSchema>;
