
import { z } from 'zod';

export const CreateLeadSchema = z.object({
  name: z.string(),
  userId: z.guid(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name', userId: '00000000-0000-4000-8000-000000000001' } });

export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;
