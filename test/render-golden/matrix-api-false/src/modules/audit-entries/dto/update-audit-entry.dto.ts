
import { z } from 'zod';
import { CreateAuditEntrySchema } from './create-audit-entry.dto';

export const UpdateAuditEntrySchema = CreateAuditEntrySchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { message: 'Example message' } });

export type UpdateAuditEntryDto = z.infer<typeof UpdateAuditEntrySchema>;
