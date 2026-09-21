// CONSUMER-OWNED, not generated — see ./account.ts.
// Mirrors `../entities/opportunity.yaml`.
import { z } from 'zod';

export const opportunitySchema = z.object({
	id: z.string(),
	accountId: z.string(),
	name: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Opportunity = z.infer<typeof opportunitySchema>;
