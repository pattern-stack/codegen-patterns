
import { z } from 'zod';

export const TicketOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  assigneeId: z.guid(),
  title: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000001', assigneeId: '00000000-0000-4000-8000-000000000001', title: 'Example title', createdAt: '2026-01-15T09:30:00.000Z', updatedAt: '2026-01-15T09:30:00.000Z' } });

export type TicketOutputDto = z.infer<typeof TicketOutputSchema>;
