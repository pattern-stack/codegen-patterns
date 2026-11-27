/**
 * The `drizzle` + `sqlite` constraint renderer (TGT-2a, ADR-047): constraint facts → Drizzle `sqlite-core` text.
 *
 * Shared with Postgres (`../shared.ts`): the `sql` predicate, `index`, `foreignKey`, `check`. Its own:
 * - a column reference's callback is annotated `AnySQLiteColumn` (the `#631` reason, in sqlite-core's type);
 * - uniques: a referenced unique is the `unique()` table constraint, a partial one `uniqueIndex(…).where(sql…)`, the
 *   rest `uniqueIndex(…)`. SQLite has no NULLS NOT DISTINCT, so that rule (a tenant-scoped entity's default) is an
 *   expression index over `ifnull(<col>, X'00')` for every column: a BLOB never equals a TEXT or INTEGER, so NULLs
 *   compare equal to each other and to nothing else — exactly NULLS NOT DISTINCT. A NOT NULL column is unchanged by
 *   the wrap.
 *
 * Registered in TGT-2b. Hygen-safe: imports only shipped modules.
 */

import type { ColumnReferenceFact, UniqueFact } from '../../../derived/constraints/types.js';
import type { ConstraintRenderer, RenderedConstraint } from '../../constraints.js';
import { check, foreignKey, index, on, predicate } from '../shared.js';

function columnReference(reference: ColumnReferenceFact): string {
	const action = reference.onDelete === undefined ? '' : `, { onDelete: '${reference.onDelete}' }`;
	return `.references((): AnySQLiteColumn => ${reference.targetExport}.${reference.targetProp}${action})`;
}

/** NULLS NOT DISTINCT on SQLite: each column as `ifnull(<col>, X'00')` (see the header). */
export const NULL_SENTINEL = "X'00'";

function unique(fact: UniqueFact, tableParam: string): RenderedConstraint {
	const comment = fact.tenantScoped ? 'tenant_scoped — unique per tenant' : null;
	if (fact.nullsNotDistinct) {
		if (fact.where !== null) throw new Error(`unique '${fact.name}': a partial unique is never NULLS NOT DISTINCT.`);
		if (fact.referenced) {
			throw new Error(`unique '${fact.name}': NULLS NOT DISTINCT is an expression index, which a foreign key cannot target.`);
		}
		const cols = fact.props.map((p) => `sql\`ifnull(\${${tableParam}.${p}}, ${NULL_SENTINEL})\``).join(', ');
		return {
			builder: 'uniqueIndex',
			expr: `uniqueIndex('${fact.name}').on(${cols})`,
			comment: fact.tenantScoped
				? "tenant_scoped — unique per tenant; NULLS NOT DISTINCT as ifnull(…, X'00'), so the NULL tenant is one partition"
				: "NULLS NOT DISTINCT as ifnull(…, X'00')",
		};
	}
	const cols = on(fact.props, tableParam);
	if (fact.where !== null) {
		if (fact.referenced) throw new Error(`unique '${fact.name}': a foreign key's target cannot be partial.`);
		return {
			builder: 'uniqueIndex',
			expr: `uniqueIndex('${fact.name}').on(${cols}).where(sql\`${predicate(fact.where, tableParam)}\`)`,
			comment,
		};
	}
	if (fact.referenced) return { builder: 'unique', expr: `unique('${fact.name}').on(${cols})`, comment: null };
	return { builder: 'uniqueIndex', expr: `uniqueIndex('${fact.name}').on(${cols})`, comment };
}

export const drizzleSqliteConstraints: ConstraintRenderer = {
	pair: 'drizzle/sqlite',
	predicate,
	columnReference,
	index,
	unique,
	foreignKey,
	check,
};
