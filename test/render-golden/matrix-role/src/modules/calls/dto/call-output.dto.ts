
import { z } from 'zod';

export const CallOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  callerId: z.guid().nullable(),
  regardingAccountId: z.guid(),
  subject: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type CallOutputDto = z.infer<typeof CallOutputSchema>;
