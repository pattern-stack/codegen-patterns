
import { z } from 'zod';
import { CreateSyncCursorSchema } from './create-sync-cursor.dto';

export const UpdateSyncCursorSchema = CreateSyncCursorSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { position: 'Example position' } });

export type UpdateSyncCursorDto = z.infer<typeof UpdateSyncCursorSchema>;
