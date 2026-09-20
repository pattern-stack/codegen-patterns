// CONSUMER-OWNED, not generated — see ./account.ts.
// Mirrors `../entities/tag.yaml`.
import { z } from 'zod';

export const tagSchema = z.object({
	id: z.string(),
	label: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Tag = z.infer<typeof tagSchema>;
