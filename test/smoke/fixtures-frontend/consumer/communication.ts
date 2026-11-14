// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/communication.yaml` (RFC-0006 family, #875) the way a real
// consumer's `@repo/db` package would: the row a Drizzle table selects. A child's
// row carries the base's kind and tenant column (RFC-0006 §2.1). Drift between
// this and the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const communicationSchema = z.object({
	id: z.string(),
	tenantId: z.string(),
	kind: z.enum(['meeting', 'email', 'message']),
	occurredAt: z.date(),
	source: z.string(),
	externalId: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Communication = z.infer<typeof communicationSchema>;
