
import { z } from 'zod';

export const SyncCursorOutputSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  position: z.string(),
});

export type SyncCursorOutputDto = z.infer<typeof SyncCursorOutputSchema>;
