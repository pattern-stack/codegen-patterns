
import { z } from 'zod';

export const CreateUserSchema = z.object({
  email: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { email: 'Example email' } });

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
