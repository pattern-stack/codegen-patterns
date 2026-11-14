// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/message_communication_part.yaml` (RFC-0006 family, #875) the way a real
// consumer's `@repo/db` package would: the row a Drizzle table selects. A child's
// row carries the base's kind and tenant column (RFC-0006 §2.1). Drift between
// this and the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const messageCommunicationPartSchema = z.object({
	id: z.string(),
	kind: z.enum(['meeting', 'email', 'message']),
	tenantId: z.string(),
	text: z.string(),
	reactionCount: z.number().nullable(),
});

export type MessageCommunicationPart = z.infer<typeof messageCommunicationPartSchema>;
