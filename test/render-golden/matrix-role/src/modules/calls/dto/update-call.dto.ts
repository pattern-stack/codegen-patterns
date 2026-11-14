
import { z } from 'zod';
import { CreateCallSchema } from './create-call.dto';

export const UpdateCallSchema = CreateCallSchema.partial();

export type UpdateCallDto = z.infer<typeof UpdateCallSchema>;
