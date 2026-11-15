
import { z } from 'zod';

export const CreateParcelSchema = z.object({
  kind: z.enum(['crate', 'loose']),
  weight: z.number().int(),
});

export type CreateParcelDto = z.infer<typeof CreateParcelSchema>;
