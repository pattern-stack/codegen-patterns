
import { z } from 'zod';

export const CreateCategorySchema = z.object({
  parentCategoryId: z.string().uuid(),
  name: z.string(),
});

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
