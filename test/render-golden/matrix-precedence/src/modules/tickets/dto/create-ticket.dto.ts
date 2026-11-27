
import { z } from 'zod';

export const CreateTicketSchema = z.object({
  accountId: z.guid(),
  assigneeId: z.guid(),
  title: z.string(),
});

export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;
