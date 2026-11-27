
import { z } from 'zod';

export const NoticeOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['info', 'alert']),
  body: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', kind: 'info', body: 'Example body' } });

export type NoticeOutputDto = z.infer<typeof NoticeOutputSchema>;
