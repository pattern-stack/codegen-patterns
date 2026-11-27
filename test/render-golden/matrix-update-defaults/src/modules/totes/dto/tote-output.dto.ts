
import { z } from 'zod';

export const ToteOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['bin', 'loose']),
  fragile: z.boolean().nullable(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', kind: 'bin', fragile: false } });

export type ToteOutputDto = z.infer<typeof ToteOutputSchema>;
