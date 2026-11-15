
import { z } from 'zod';

export const NoticeOutputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['info', 'alert']),
  body: z.string(),
});

export type NoticeOutputDto = z.infer<typeof NoticeOutputSchema>;
