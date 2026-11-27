
import { z } from 'zod';

export const CreateMemberSchema = z.object({
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type CreateMemberDto = z.infer<typeof CreateMemberSchema>;
