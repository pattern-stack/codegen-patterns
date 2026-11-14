
import { z } from 'zod';
import { CreateFieldDefinitionSchema } from './create-field-definition.dto';

export const UpdateFieldDefinitionSchema = CreateFieldDefinitionSchema.partial();

export type UpdateFieldDefinitionDto = z.infer<typeof UpdateFieldDefinitionSchema>;
