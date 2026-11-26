
import { z } from 'zod';

export const CreateShelfSchema = z.object({
  label: z.string(),
  active: z.boolean().default(false),
  archived: z.boolean().default(false),
});

export type CreateShelfDto = z.infer<typeof CreateShelfSchema>;
