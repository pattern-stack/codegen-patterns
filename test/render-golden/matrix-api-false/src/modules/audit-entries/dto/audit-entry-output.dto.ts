
import { z } from 'zod';

export const AuditEntryOutputSchema = z.object({
  id: z.guid(),
  message: z.string(),
});

export type AuditEntryOutputDto = z.infer<typeof AuditEntryOutputSchema>;
