
import { z } from 'zod';
import { CreateMemberSchema } from './create-member.dto';

export const UpdateMemberSchema = CreateMemberSchema.partial();

export type UpdateMemberDto = z.infer<typeof UpdateMemberSchema>;
