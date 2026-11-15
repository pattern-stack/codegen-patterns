
import { z } from 'zod';

export const MemberOutputSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type MemberOutputDto = z.infer<typeof MemberOutputSchema>;
