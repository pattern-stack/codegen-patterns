
import { z } from 'zod';
import { CreateNoticeSchema } from './create-notice.dto';

export const UpdateNoticeSchema = CreateNoticeSchema.partial();

export type UpdateNoticeDto = z.infer<typeof UpdateNoticeSchema>;
