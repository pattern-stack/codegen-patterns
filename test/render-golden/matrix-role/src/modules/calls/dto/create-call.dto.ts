
import { z } from 'zod';

export const CreateCallSchema = z.object({
  accountId: z.string().uuid(),
  callerId: z.string().uuid().nullable().optional(),
  regardingAccountId: z.string().uuid(),
  subject: z.string(),
});

export type CreateCallDto = z.infer<typeof CreateCallSchema>;
