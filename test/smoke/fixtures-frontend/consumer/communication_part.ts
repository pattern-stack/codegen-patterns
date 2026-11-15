// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/communication_part.yaml` (RFC-0006 family, #875) the way a real
// consumer's `@repo/db` package would: the row a Drizzle table selects. A child's
// row carries the base's kind and tenant column (RFC-0006 §2.1). Drift between
// this and the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const communicationPartSchema = z.object({
	id: z.string(),
	tenantId: z.string(),
	kind: z.enum(['meeting', 'email', 'message']),
	sequence: z.number(),
	communicationId: z.string(),
	deletedAt: z.date().nullable(),
});

export type CommunicationPart = z.infer<typeof communicationPartSchema>;
