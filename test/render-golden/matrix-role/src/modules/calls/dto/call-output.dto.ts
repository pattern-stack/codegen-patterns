
import { z } from 'zod';

export const CallOutputSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  callerId: z.string().uuid().nullable(),
  regardingAccountId: z.string().uuid(),
  subject: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type CallOutputDto = z.infer<typeof CallOutputSchema>;
