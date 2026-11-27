
import { z } from 'zod';

export const CategoryOutputSchema = z.object({
  id: z.guid(),
  parentCategoryId: z.guid(),
  name: z.string(),
});

export type CategoryOutputDto = z.infer<typeof CategoryOutputSchema>;
