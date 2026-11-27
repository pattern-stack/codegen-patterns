
import { z } from 'zod';

export const CreateLeadSchema = z.object({
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;
