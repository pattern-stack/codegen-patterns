
import { z } from 'zod';

export const CreateMemberSchema = z.object({
  name: z.string(),
});

export type CreateMemberDto = z.infer<typeof CreateMemberSchema>;
