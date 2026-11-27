
import { z } from 'zod';

export const TicketOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  assigneeId: z.guid(),
  title: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type TicketOutputDto = z.infer<typeof TicketOutputSchema>;
