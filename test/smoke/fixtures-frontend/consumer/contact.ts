// CONSUMER-OWNED, not generated — see ./account.ts.
// Mirrors `../entities/contact.yaml`.
import { z } from 'zod';

export const contactSchema = z.object({
	id: z.string(),
	accountId: z.string(),
	email: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Contact = z.infer<typeof contactSchema>;
