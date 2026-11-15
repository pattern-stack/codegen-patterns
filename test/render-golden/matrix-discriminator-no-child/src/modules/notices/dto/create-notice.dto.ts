
import { z } from 'zod';

export const CreateNoticeSchema = z.object({
  kind: z.enum(['info', 'alert']),
  body: z.string(),
});

export type CreateNoticeDto = z.infer<typeof CreateNoticeSchema>;
