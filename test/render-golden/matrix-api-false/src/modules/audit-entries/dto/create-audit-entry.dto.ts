
import { z } from 'zod';

export const CreateAuditEntrySchema = z.object({
  message: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { message: 'Example message' } });

export type CreateAuditEntryDto = z.infer<typeof CreateAuditEntrySchema>;
