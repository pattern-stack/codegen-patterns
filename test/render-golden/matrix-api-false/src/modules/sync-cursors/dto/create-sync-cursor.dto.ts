
import { z } from 'zod';

export const CreateSyncCursorSchema = z.object({
  accountId: z.guid().meta({ description: 'The id of an existing account (GET /accounts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  position: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { accountId: '00000000-0000-4000-8000-000000000001', position: 'Example position' } });

export type CreateSyncCursorDto = z.infer<typeof CreateSyncCursorSchema>;
