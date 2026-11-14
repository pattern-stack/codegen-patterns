
import { z } from 'zod';

export const CreateAuditEntrySchema = z.object({
  message: z.string(),
});

export type CreateAuditEntryDto = z.infer<typeof CreateAuditEntrySchema>;
