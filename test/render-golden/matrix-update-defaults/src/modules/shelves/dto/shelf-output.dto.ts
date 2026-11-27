
import { z } from 'zod';

export const ShelfOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
  active: z.boolean().nullable(),
  archived: z.boolean().nullable(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', label: 'Example label', active: true, archived: false } });

export type ShelfOutputDto = z.infer<typeof ShelfOutputSchema>;
