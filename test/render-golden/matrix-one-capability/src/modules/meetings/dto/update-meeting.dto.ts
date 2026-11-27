
import { z } from 'zod';
import { CreateMeetingSchema } from './create-meeting.dto';

export const UpdateMeetingSchema = CreateMeetingSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { title: 'Example title' } });

export type UpdateMeetingDto = z.infer<typeof UpdateMeetingSchema>;
