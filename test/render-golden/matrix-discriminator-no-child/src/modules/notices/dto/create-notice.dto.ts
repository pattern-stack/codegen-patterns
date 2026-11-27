
import { z } from 'zod';

export const CreateNoticeSchema = z.object({
  kind: z.enum(['info', 'alert']),
  body: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { kind: 'info', body: 'Example body' } });

export type CreateNoticeDto = z.infer<typeof CreateNoticeSchema>;
