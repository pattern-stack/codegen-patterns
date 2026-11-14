
import { z } from 'zod';
import { CreateSyncCursorSchema } from './create-sync-cursor.dto';

export const UpdateSyncCursorSchema = CreateSyncCursorSchema.partial();

export type UpdateSyncCursorDto = z.infer<typeof UpdateSyncCursorSchema>;
