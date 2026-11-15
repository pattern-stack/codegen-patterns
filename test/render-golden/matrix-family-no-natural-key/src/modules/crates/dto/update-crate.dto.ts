
import { z } from 'zod';
import { CreateCrateSchema } from './create-crate.dto';

export const UpdateCrateSchema = CreateCrateSchema.partial();

export type UpdateCrateDto = z.infer<typeof UpdateCrateSchema>;
