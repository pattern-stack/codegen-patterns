
import { z } from 'zod';

export const ShelfOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
  active: z.boolean().nullable(),
  archived: z.boolean().nullable(),
});

export type ShelfOutputDto = z.infer<typeof ShelfOutputSchema>;
