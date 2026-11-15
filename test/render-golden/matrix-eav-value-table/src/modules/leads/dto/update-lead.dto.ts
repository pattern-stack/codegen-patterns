
import { z } from 'zod';
import { CreateLeadSchema } from './create-lead.dto';

export const UpdateLeadSchema = CreateLeadSchema.partial();

export type UpdateLeadDto = z.infer<typeof UpdateLeadSchema>;
