
import { z } from 'zod';
import { CreateNoticeSchema } from './create-notice.dto';

// RFC-0006 §4.1: a row does not change kind, so the update takes no `kind`; one in a body is stripped.
export const UpdateNoticeSchema = CreateNoticeSchema.omit({ kind: true }).partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { body: 'Example body' } });

export type UpdateNoticeDto = z.infer<typeof UpdateNoticeSchema>;
