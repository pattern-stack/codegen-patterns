/**
 * Drizzle text every Drizzle dialect writes the same way (TGT-2a): the `sql` template a predicate or CHECK becomes, and
 * the `index` / `foreignKey` / `check` extra-config builders, which `pg-core` and `sqlite-core` spell identically. Each
 * pair's constraint renderer (`./<database>/constraints.ts`) uses these and writes what differs itself (references'
 * column type, uniques).
 *
 * Moved verbatim from `./postgres/constraints.ts`, so Postgres's bytes are unchanged. Hygen-safe: type imports only.
 */

import type { PredicateSegment } from '../../derived/constraints/predicate.js';
import type { CheckFact, ForeignKeyFact, IndexFact } from '../../derived/constraints/types.js';

/** Escape text for a JS template literal. */
function escapeTemplate(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * The body of a Drizzle `sql\`…\`` template: text escaped for a template literal, a column as `${<tableParam>.<prop>}`
 * so drizzle-kit quotes it. Unquoted predicate text cannot hold `` ` ``, `\` or `$` (the tokenizer refuses them), so
 * escaping every text segment changes only quoted strings — exactly what the single-pass renderer did.
 */
export function predicate(segments: readonly PredicateSegment[], tableParam: string): string {
	if (typeof tableParam !== 'string' || tableParam === '') {
		throw new Error('predicate: the callback parameter name (tableParam) is required');
	}
	return segments.map((s) => ('text' in s ? escapeTemplate(s.text) : '${' + tableParam + '.' + s.prop + '}')).join('');
}

/** The extra-config callback's column list: `<tableParam>.<prop>, …`. */
export const on = (props: readonly string[], tableParam: string) => props.map((p) => `${tableParam}.${p}`).join(', ');

export function index(fact: IndexFact, tableParam: string): string {
	return `index('${fact.name}').on(${on(fact.props, tableParam)})`;
}

export function foreignKey(fact: ForeignKeyFact, tableParam: string): string {
	return (
		`foreignKey({\n` +
		`      name: '${fact.name}',\n` +
		`      columns: [${on(fact.props, tableParam)}],\n` +
		`      foreignColumns: [${on(fact.targetProps, fact.targetExport)}],\n` +
		`    }).onDelete('${fact.onDelete}')`
	);
}

export function check(fact: CheckFact, tableParam: string): string {
	return `check('${fact.name}', sql\`${predicate(fact.expression, tableParam)}\`)`;
}
