// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/transcript_communication_part.yaml` (RFC-0006 family, #875) the way a real
// consumer's `@repo/db` package would: the row a Drizzle table selects. A child's
// row carries the base's kind and tenant column (RFC-0006 §2.1). Drift between
// this and the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const transcriptCommunicationPartSchema = z.object({
	id: z.string(),
	kind: z.enum(['meeting', 'email', 'message']),
	tenantId: z.string(),
	text: z.string(),
	startMs: z.number().nullable(),
	endMs: z.number().nullable(),
	transcriptId: z.string(),
	participantId: z.string().nullable(),
});

export type TranscriptCommunicationPart = z.infer<typeof transcriptCommunicationPartSchema>;
