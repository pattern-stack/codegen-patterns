
import { z } from 'zod';

export const CreateToteSchema = z.object({
  kind: z.enum(['loose']),
  fragile: z.boolean().default(false),
});

export type CreateToteDto = z.infer<typeof CreateToteSchema>;
