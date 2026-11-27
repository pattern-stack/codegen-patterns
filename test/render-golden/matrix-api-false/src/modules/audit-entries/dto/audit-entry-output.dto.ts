
import { z } from 'zod';

export const AuditEntryOutputSchema = z.object({
  id: z.guid(),
  message: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', message: 'Example message' } });

export type AuditEntryOutputDto = z.infer<typeof AuditEntryOutputSchema>;
