
import { z } from 'zod';

export const CreateTicketSchema = z.object({
  accountId: z.string().uuid(),
  assigneeId: z.string().uuid(),
  title: z.string(),
});

export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;
