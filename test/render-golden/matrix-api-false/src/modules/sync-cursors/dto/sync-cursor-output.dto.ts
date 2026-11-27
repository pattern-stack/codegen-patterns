
import { z } from 'zod';

export const SyncCursorOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  position: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000001', position: 'Example position' } });

export type SyncCursorOutputDto = z.infer<typeof SyncCursorOutputSchema>;
