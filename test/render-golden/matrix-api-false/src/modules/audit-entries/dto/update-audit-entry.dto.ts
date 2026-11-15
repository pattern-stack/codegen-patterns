
import { z } from 'zod';
import { CreateAuditEntrySchema } from './create-audit-entry.dto';

export const UpdateAuditEntrySchema = CreateAuditEntrySchema.partial();

export type UpdateAuditEntryDto = z.infer<typeof UpdateAuditEntrySchema>;
