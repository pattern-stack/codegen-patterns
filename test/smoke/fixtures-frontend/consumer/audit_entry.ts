// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/audit_entry.yaml` the way a real consumer's `@repo/db` package would. Drift between this and
// the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const auditEntrySchema = z.object({
	id: z.string(),
	note: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
