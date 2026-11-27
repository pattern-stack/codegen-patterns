
import { z } from 'zod';

export const CreateMeetingSchema = z.object({
  hostContactId: z.guid(),
  title: z.string(),
});

export type CreateMeetingDto = z.infer<typeof CreateMeetingSchema>;
