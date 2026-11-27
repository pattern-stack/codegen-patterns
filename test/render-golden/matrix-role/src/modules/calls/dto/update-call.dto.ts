
import { z } from 'zod';
import { CreateCallSchema } from './create-call.dto';

export const UpdateCallSchema = CreateCallSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { subject: 'Example subject' } });

export type UpdateCallDto = z.infer<typeof UpdateCallSchema>;
