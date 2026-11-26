/**
 * The `drizzle` + `postgres` constraint renderer (TGT-1, ADR-047): constraint facts → Drizzle `pg-core` text.
 *
 * Every string here is Drizzle-on-Postgres text; the facts it reads hold none. Moved verbatim from
 * `templates/entity/new/backend/entity-locals.js` and `templates/_shared/sql-predicate.mjs` — the bytes it renders are
 * the bytes the goldens pin.
 *
 * Hygen-safe: reached from `entity-locals.js`, so it imports only modules that ship in the package's `files`.
 */

import type { PredicateSegment } from '../../../derived/constraints/predicate.js';
import type { ColumnReferenceFact, IndexFact } from '../../../derived/constraints/types.js';
import type { ConstraintRenderer } from '../../constraints.js';

/** Escape text for a JS template literal. */
function escapeTemplate(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * The body of a Drizzle `sql\`…\`` template: text escaped for a template literal, a column as `${<tableParam>.<prop>}`
 * so drizzle-kit quotes it. Unquoted predicate text cannot hold `` ` ``, `\` or `$` (the tokenizer refuses them), so
 * escaping every text segment changes only quoted strings — exactly what the single-pass renderer did.
 */
function predicate(segments: readonly PredicateSegment[], tableParam: string): string {
	if (typeof tableParam !== 'string' || tableParam === '') {
		throw new Error('predicate: the callback parameter name (tableParam) is required');
	}
	return segments.map((s) => ('text' in s ? escapeTemplate(s.text) : '${' + tableParam + '.' + s.prop + '}')).join('');
}

/**
 * `.references(…)` on the column. The callback is annotated `AnyPgColumn` on every FK (#631): a self-reference, or a
 * cycle through another table, otherwise makes the table's type refer to itself.
 */
function columnReference(reference: ColumnReferenceFact): string {
	return `.references((): AnyPgColumn => ${reference.targetExport}.${reference.targetColumn})`;
}

function index(fact: IndexFact, tableParam: string): string {
	return `index('${fact.name}').on(${fact.props.map((p) => `${tableParam}.${p}`).join(', ')})`;
}

export const drizzlePostgresConstraints: ConstraintRenderer = {
	pair: 'drizzle/postgres',
	predicate,
	columnReference,
	index,
};
