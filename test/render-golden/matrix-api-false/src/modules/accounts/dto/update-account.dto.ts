
import { z } from 'zod';
import { CreateAccountSchema } from './create-account.dto';

export const UpdateAccountSchema = CreateAccountSchema.partial();

export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>;
