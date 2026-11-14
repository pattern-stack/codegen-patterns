
import { z } from 'zod';
import { CreateCategorySchema } from './create-category.dto';

export const UpdateCategorySchema = CreateCategorySchema.partial();

export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;
