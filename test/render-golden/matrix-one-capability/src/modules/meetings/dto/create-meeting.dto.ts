
import { z } from 'zod';

export const CreateMeetingSchema = z.object({
  hostContactId: z.string().uuid(),
  title: z.string(),
});

export type CreateMeetingDto = z.infer<typeof CreateMeetingSchema>;
