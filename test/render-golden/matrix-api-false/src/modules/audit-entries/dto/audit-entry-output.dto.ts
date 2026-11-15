
import { z } from 'zod';

export const AuditEntryOutputSchema = z.object({
  id: z.string().uuid(),
  message: z.string(),
});

export type AuditEntryOutputDto = z.infer<typeof AuditEntryOutputSchema>;
