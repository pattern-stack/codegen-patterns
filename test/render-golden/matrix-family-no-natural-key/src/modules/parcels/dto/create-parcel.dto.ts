
import { z } from 'zod';

export const CreateParcelSchema = z.object({
  kind: z.enum(['loose']),
  weight: z.number().int(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { kind: 'loose', weight: 1 } });

export type CreateParcelDto = z.infer<typeof CreateParcelSchema>;
