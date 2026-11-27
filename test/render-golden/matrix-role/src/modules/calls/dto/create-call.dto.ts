
import { z } from 'zod';

export const CreateCallSchema = z.object({
  accountId: z.guid(),
  callerId: z.guid().nullable().optional(),
  regardingAccountId: z.guid(),
  subject: z.string(),
});

export type CreateCallDto = z.infer<typeof CreateCallSchema>;
