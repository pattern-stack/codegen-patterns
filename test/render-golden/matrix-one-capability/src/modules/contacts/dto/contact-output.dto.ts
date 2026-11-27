
import { z } from 'zod';

export const ContactOutputSchema = z.object({
  id: z.guid(),
  email: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', email: 'Example email' } });

export type ContactOutputDto = z.infer<typeof ContactOutputSchema>;
