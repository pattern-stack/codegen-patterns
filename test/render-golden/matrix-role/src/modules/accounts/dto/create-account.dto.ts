
import { z } from 'zod';

export const CreateAccountSchema = z.object({
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;
