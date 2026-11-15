
import { z } from 'zod';
import { CreateFieldValueSchema } from './create-field-value.dto';

export const UpdateFieldValueSchema = CreateFieldValueSchema.partial();

export type UpdateFieldValueDto = z.infer<typeof UpdateFieldValueSchema>;
