
import { z } from 'zod';

export const CreateContactSchema = z.object({
  email: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { email: 'Example email' } });

export type CreateContactDto = z.infer<typeof CreateContactSchema>;
