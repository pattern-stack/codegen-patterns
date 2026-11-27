
import { z } from 'zod';
import { CreateContactSchema } from './create-contact.dto';

export const UpdateContactSchema = CreateContactSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { email: 'Example email' } });

export type UpdateContactDto = z.infer<typeof UpdateContactSchema>;
