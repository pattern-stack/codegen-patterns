
import { z } from 'zod';
import { CreateMeetingSchema } from './create-meeting.dto';

export const UpdateMeetingSchema = CreateMeetingSchema.partial();

export type UpdateMeetingDto = z.infer<typeof UpdateMeetingSchema>;
