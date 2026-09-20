// CONSUMER-OWNED, not generated.
//
// `locations.dbEntities` (default import `@repo/db/entities`) names a module
// the consumer provides — no template writes there (ADR-038). The emitted
// frontend imports `<camel>Schema` (a standard-schema handed to
// `createCollection`) and `type <Class>` from it, so the smoke supplies the
// same thing a real consumer's `@repo/db` package would.
//
// These mirror `../entities/account.yaml`. Drift between them shows up as a
// `tsc` error in the emitted tree, which is the correct failure.
import { z } from 'zod';

export const accountSchema = z.object({
	id: z.string(),
	name: z.string(),
	status: z.enum(['active', 'churned']),
	parentAccountId: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Account = z.infer<typeof accountSchema>;
