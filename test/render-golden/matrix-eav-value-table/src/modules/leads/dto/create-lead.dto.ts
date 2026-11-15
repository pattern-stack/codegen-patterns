
import { z } from 'zod';

export const CreateLeadSchema = z.object({
  name: z.string(),
});

export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;
