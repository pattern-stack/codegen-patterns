// CONSUMER-OWNED, not generated — see ./account.ts.
//
// The junction's row type. Junction tables are consumer-owned in
// `@repo/db/entities` for exactly the same reason entities are: no template
// writes there. Mirrors what `templates/junction/new/entity.ejs.t` emits for
// `../junctions/opportunity_tag.yaml` — the two FK columns (the composite
// primary key; there is no surrogate `id`), the declared `role` enum, the
// always-emitted `is_primary`, and the temporal + provenance columns that
// default on.
import { z } from 'zod';

export const opportunityTagSchema = z.object({
	opportunityId: z.string(),
	tagId: z.string(),
	role: z.enum(['primary', 'secondary']),
	isPrimary: z.boolean(),
	startedAt: z.date().nullable(),
	endedAt: z.date().nullable(),
	sourcedFrom: z.string().nullable(),
	confidence: z.string().nullable(),
	matchedAt: z.date().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type OpportunityTag = z.infer<typeof opportunityTagSchema>;
