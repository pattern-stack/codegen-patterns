/**
 * The `drizzle` + `sqlite` constraint renderer (TGT-2a, ADR-047): constraint facts → Drizzle `sqlite-core` text.
 *
 * Shared with Postgres (`../shared.ts`): the `sql` predicate, `index`, `foreignKey`, `check`. Its own:
 * - a column reference's callback is annotated `AnySQLiteColumn` (the `#631` reason, in sqlite-core's type);
 * - uniques: SQLite has no NULLS NOT DISTINCT, so such a unique is refused by name (the composer states it only for a
 *   tenant-scoped entity, and an alternative — an expression index over `coalesce` — waits for someone who needs it);
 *   a referenced unique is the `unique()` table constraint, a partial one `uniqueIndex(…).where(sql…)`, the rest
 *   `uniqueIndex(…)`.
 *
 * Not yet registered: the pair's row comes in TGT-2b. Hygen-safe: imports only shipped modules.
 */

import type { ColumnReferenceFact, UniqueFact } from '../../../derived/constraints/types.js';
import type { ConstraintRenderer, RenderedConstraint } from '../../constraints.js';
import { check, foreignKey, index, on, predicate } from '../shared.js';

function columnReference(reference: ColumnReferenceFact): string {
	const action = reference.onDelete === undefined ? '' : `, { onDelete: '${reference.onDelete}' }`;
	return `.references((): AnySQLiteColumn => ${reference.targetExport}.${reference.targetProp}${action})`;
}

function unique(fact: UniqueFact, tableParam: string): RenderedConstraint {
	if (fact.nullsNotDistinct) {
		throw new Error(
			`unique '${fact.name}': SQLite has no NULLS NOT DISTINCT (a tenant-scoped unique states it); drizzle/sqlite cannot write it.`,
		);
	}
	const cols = on(fact.props, tableParam);
	const comment = fact.tenantScoped ? 'tenant_scoped — unique per tenant' : null;
	if (fact.where !== null) {
		return {
			builder: 'uniqueIndex',
			expr: `uniqueIndex('${fact.name}').on(${cols}).where(sql\`${predicate(fact.where, tableParam)}\`)`,
			comment,
		};
	}
	if (fact.referenced) return { builder: 'unique', expr: `unique('${fact.name}').on(${cols})`, comment: null };
	return { builder: 'uniqueIndex', expr: `uniqueIndex('${fact.name}').on(${cols})`, comment };
}

export const drizzleSqliteConstraints: ConstraintRenderer<'drizzle/sqlite'> = {
	pair: 'drizzle/sqlite',
	predicate,
	columnReference,
	index,
	unique,
	foreignKey,
	check,
};
