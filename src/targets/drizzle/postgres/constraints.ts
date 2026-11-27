/**
 * The `drizzle` + `postgres` constraint renderer (TGT-1, ADR-047): constraint facts → Drizzle `pg-core` text.
 *
 * Every string here is Drizzle-on-Postgres text; the facts it reads hold none. Moved verbatim from
 * `templates/entity/new/backend/entity-locals.js` and `templates/_shared/sql-predicate.mjs` — the bytes it renders are
 * the bytes the goldens pin.
 *
 * Hygen-safe: reached from `entity-locals.js`, so it imports only modules that ship in the package's `files`.
 */

import type { ColumnReferenceFact, UniqueFact } from '../../../derived/constraints/types.js';
import type { ConstraintRenderer, RenderedConstraint } from '../../constraints.js';
import { check, foreignKey, index, on, predicate } from '../shared.js';

/**
 * `.references(…)` on the column. The callback is annotated `AnyPgColumn` on every FK (#631): a self-reference, or a
 * cycle through another table, otherwise makes the table's type refer to itself.
 */
function columnReference(reference: ColumnReferenceFact): string {
	const action = reference.onDelete === undefined ? '' : `, { onDelete: '${reference.onDelete}' }`;
	return `.references((): AnyPgColumn => ${reference.targetExport}.${reference.targetProp}${action})`;
}


/**
 * - partial (`where`) → `uniqueIndex(name).on(…).where(sql\`…\`)`. A partial index cannot be NULLS NOT DISTINCT on
 *   drizzle-orm 1.0.0-rc.4, so that fact is refused (the composer never states it);
 * - a referenced unique → `unique(name).on(…)`: a UNIQUE constraint, the target of a composite FK;
 * - NULLS NOT DISTINCT → `unique(name).on(…).nullsNotDistinct()`: only the table-constraint builder carries it on rc.4;
 * - otherwise → `uniqueIndex(name).on(…)`.
 */
function unique(fact: UniqueFact, tableParam: string): RenderedConstraint {
	const cols = on(fact.props, tableParam);
	if (fact.where !== null) {
		if (fact.nullsNotDistinct) {
			throw new Error(`unique '${fact.name}': drizzle/postgres cannot write a partial unique NULLS NOT DISTINCT (rc.4).`);
		}
		return {
			builder: 'uniqueIndex',
			expr: `uniqueIndex('${fact.name}').on(${cols}).where(sql\`${predicate(fact.where, tableParam)}\`)`,
			comment: fact.tenantScoped
				? 'tenant_scoped — unique per tenant; partial, so NULL-tenant rows never conflict (no NULLS NOT DISTINCT on a partial index in drizzle rc.4)'
				: null,
		};
	}
	if (fact.referenced) {
		return { builder: 'unique', expr: `unique('${fact.name}').on(${cols})`, comment: null };
	}
	if (fact.nullsNotDistinct) {
		return {
			builder: 'unique',
			expr: `unique('${fact.name}').on(${cols}).nullsNotDistinct()`,
			comment: fact.tenantScoped
				? 'tenant_scoped — unique per tenant; NULLS NOT DISTINCT, so the NULL tenant is one partition (ADR-042)'
				: null,
		};
	}
	return {
		builder: 'uniqueIndex',
		expr: `uniqueIndex('${fact.name}').on(${cols})`,
		comment: fact.tenantScoped
			? 'tenant_scoped — unique per tenant; nulls_not_distinct: false, so NULL-tenant rows never conflict'
			: null,
	};
}



export const drizzlePostgresConstraints: ConstraintRenderer = {
	pair: 'drizzle/postgres',
	predicate,
	columnReference,
	index,
	unique,
	foreignKey,
	check,
};
