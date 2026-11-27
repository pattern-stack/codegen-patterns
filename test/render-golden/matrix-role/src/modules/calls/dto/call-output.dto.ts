
import { z } from 'zod';

export const CallOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  callerId: z.guid().nullable(),
  regardingAccountId: z.guid(),
  subject: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000001', callerId: '00000000-0000-4000-8000-000000000001', regardingAccountId: '00000000-0000-4000-8000-000000000001', subject: 'Example subject', createdAt: '2026-01-15T09:30:00.000Z', updatedAt: '2026-01-15T09:30:00.000Z' } });

export type CallOutputDto = z.infer<typeof CallOutputSchema>;
