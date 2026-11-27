
import { z } from 'zod';
import { CreateAccountSchema } from './create-account.dto';

export const UpdateAccountSchema = CreateAccountSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>;
