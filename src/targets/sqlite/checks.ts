/**
 * The CHECKs SQLite needs where Postgres enforces through a type (TGT-2a): SQLite has no enum type and ignores a TEXT
 * length, so an enum column and a `max_length` column each get one. Database-level, not Drizzle's: the drizzle/sqlite
 * table (`check(…)`) and the DDL (`CHECK (…)`) both render these facts, from this one owner.
 *
 * Names are `<table>_<column>_in` and `<table>_<column>_len`; neither collides with the RFC-0006 `_check` /
 * `_match_check` names. A joined-table child's inherited kind column has none: its `<table>_<kind>_check` already
 * fixes it to one value. Hygen-safe: type imports only.
 */

import type { CheckFact } from '../../derived/constraints/types.js';
import type { ColumnFact } from '../../derived/tables/types.js';

const quoteSql = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function sqliteStorageChecks(table: string, columns: readonly ColumnFact[]): CheckFact[] {
	const checks: CheckFact[] = [];
	for (const c of columns) {
		if (c.kind === 'enum' && !c.isArray && c.origin !== 'inherited' && c.choices && c.choices.length > 0) {
			checks.push({
				name: `${table}_${c.name}_in`,
				expression: [{ column: c.name, prop: c.prop }, { text: ` IN (${c.choices.map(quoteSql).join(', ')})` }],
			});
		}
		if (c.kind === 'string' && !c.isArray && c.maxLength !== null) {
			checks.push({
				name: `${table}_${c.name}_len`,
				expression: [{ text: 'length(' }, { column: c.name, prop: c.prop }, { text: `) <= ${c.maxLength}` }],
			});
		}
	}
	return checks;
}
