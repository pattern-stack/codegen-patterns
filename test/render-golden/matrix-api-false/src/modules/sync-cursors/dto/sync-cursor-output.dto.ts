
import { z } from 'zod';

export const SyncCursorOutputSchema = z.object({
  id: z.guid(),
  accountId: z.guid(),
  position: z.string(),
});

export type SyncCursorOutputDto = z.infer<typeof SyncCursorOutputSchema>;
