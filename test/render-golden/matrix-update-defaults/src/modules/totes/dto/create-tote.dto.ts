
import { z } from 'zod';

export const CreateToteSchema = z.object({
  kind: z.enum(['loose']),
  fragile: z.boolean().default(false),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { kind: 'loose', fragile: false } });

export type CreateToteDto = z.infer<typeof CreateToteSchema>;
