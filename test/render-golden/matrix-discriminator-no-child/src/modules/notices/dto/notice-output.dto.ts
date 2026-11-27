
import { z } from 'zod';

export const NoticeOutputSchema = z.object({
  id: z.guid(),
  kind: z.enum(['info', 'alert']),
  body: z.string(),
});

export type NoticeOutputDto = z.infer<typeof NoticeOutputSchema>;
