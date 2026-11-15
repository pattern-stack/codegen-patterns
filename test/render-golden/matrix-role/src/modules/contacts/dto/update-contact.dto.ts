
import { z } from 'zod';
import { CreateContactSchema } from './create-contact.dto';

export const UpdateContactSchema = CreateContactSchema.partial();

export type UpdateContactDto = z.infer<typeof UpdateContactSchema>;
