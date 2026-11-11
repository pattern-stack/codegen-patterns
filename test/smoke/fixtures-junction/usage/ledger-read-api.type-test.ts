/**
 * READ-1 review R-1 — a COMPOSED repository (the app pattern's `WithAudited`
 * mixin, `return X as TBase & typeof X` style) types its read filters over ITS
 * table, not the `PgTable` the mixin erased `TTable` to.
 *
 * Copied next to the generated ledger module by the junction smoke's custom-layout
 * legs and compiled by its `tsc` step. `opportunities` shares the `id` column with
 * `ledgers`, so a filter written for it would — if it compiled — silently count
 * on the wrong predicate. Every negative is a `@ts-expect-error` (TS2578 keeps
 * them honest).
 */
import { eq } from 'drizzle-orm';
import type { LedgerRepository } from './ledger.repository';
import type { LedgerService } from './ledger.service';
import type { ledgers } from './ledger.entity';
import type { opportunities } from '../opportunities/opportunity.entity';

declare const repo: LedgerRepository;
declare const service: LedgerService;

const own = (t: typeof ledgers) => eq(t.title, 'x');
const other = (t: typeof opportunities) => eq(t.id, 'x');

export async function composedOwnTable(): Promise<void> {
	await repo.count(own);
	await service.count(own);
	await repo.list({ where: own });
	await service.list({ where: own });
	await repo.count((t) => eq(t.title, 'x'));
}

export async function composedOtherTable(): Promise<void> {
	// @ts-expect-error — another table's filter on a composed repository's count
	await repo.count(other);
	// @ts-expect-error — another table's filter on a composed service's count
	await service.count(other);
	// @ts-expect-error — another table's filter on a composed repository's list
	await repo.list({ where: other });
	// @ts-expect-error — another table's filter on a composed service's list
	await service.list({ where: other });
}
