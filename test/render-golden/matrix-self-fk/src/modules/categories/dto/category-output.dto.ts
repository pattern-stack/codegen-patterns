
import { z } from 'zod';

export const CategoryOutputSchema = z.object({
  id: z.string().uuid(),
  parentCategoryId: z.string().uuid(),
  name: z.string(),
});

export type CategoryOutputDto = z.infer<typeof CategoryOutputSchema>;
