
import { z } from 'zod';

export const TicketOutputSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  assigneeId: z.string().uuid(),
  title: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type TicketOutputDto = z.infer<typeof TicketOutputSchema>;
