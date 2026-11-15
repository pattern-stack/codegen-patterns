
import { z } from 'zod';

export const CreateCrateSchema = z.object({
  label: z.string(),
});

export type CreateCrateDto = z.infer<typeof CreateCrateSchema>;
