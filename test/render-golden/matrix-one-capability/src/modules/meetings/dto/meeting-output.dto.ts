
import { z } from 'zod';

export const MeetingOutputSchema = z.object({
  id: z.guid(),
  hostContactId: z.guid(),
  title: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type MeetingOutputDto = z.infer<typeof MeetingOutputSchema>;
