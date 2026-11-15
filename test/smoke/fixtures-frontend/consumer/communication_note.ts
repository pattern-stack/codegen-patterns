// CONSUMER-OWNED, not generated.
//
// Mirrors `../entities/communication_note.yaml` (RFC-0006 family, #875) the way a real
// consumer's `@repo/db` package would: the row a Drizzle table selects. A child's
// row carries the base's kind and tenant column (RFC-0006 §2.1). Drift between
// this and the YAML shows up as a `tsc` error in the emitted tree.
import { z } from 'zod';

export const communicationNoteSchema = z.object({
	id: z.string(),
	body: z.string(),
	communicationId: z.string().nullable(),
	roleId: z.string().nullable(),
	communicationKind: z.enum(['meeting', 'email', 'message']).nullable(),
});

export type CommunicationNote = z.infer<typeof communicationNoteSchema>;
