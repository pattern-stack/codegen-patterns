
import { z } from 'zod';

export const CreateSyncCursorSchema = z.object({
  accountId: z.string().uuid(),
  position: z.string(),
});

export type CreateSyncCursorDto = z.infer<typeof CreateSyncCursorSchema>;
