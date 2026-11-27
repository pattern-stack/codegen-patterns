/**
 * SQLite DDL from table facts (TGT-2a, G9): `CREATE TABLE IF NOT EXISTS` plus `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
 * from the same column and constraint facts the drizzle/sqlite renderers write. Database-level, not Drizzle's: any
 * ORM on SQLite emits the same `.sql`. `IF NOT EXISTS` throughout, so a consumer can apply it again (crew's
 * `migrate(ddl)` at compose). Migrations between versions are out of scope.
 *
 * - Column types follow the storage the drizzle/sqlite column renderer writes: INTEGER for `integer` / `boolean`,
 *   TEXT for everything else (ISO instants, decimals, uuids, JSON, enums).
 * - A single-column reference is inline (`REFERENCES t(c) ON DELETE …`); a composite foreign key, a UNIQUE constraint
 *   (a referenced unique) and every CHECK — the table's own and SQLite's storage CHECKs (`./checks.ts`) — are
 *   table constraints; a unique or plain index is a `CREATE INDEX`.
 * - A reference names its target by the Drizzle export; the SQL table is resolved from the set being rendered, so a
 *   target outside the set is an error naming it.
 * - Tables are written in reference order (a cycle is an error naming it); a self-reference is not a dependency.
 * - SQLite has no NULLS NOT DISTINCT: such a unique (a tenant-scoped entity's default) is a unique index over
 *   `ifnull(<col>, X'00')` per column, as the drizzle/sqlite renderer writes it (its header says why that is exact).
 *
 * Hygen-safe: imports only shipped modules.
 */

import type { PredicateSegment } from '../../derived/constraints/predicate.js';
import type { ConstraintFact } from '../../derived/constraints/types.js';
import type { ColumnFact } from '../../derived/tables/types.js';
import { sqliteNow } from '../drizzle/sqlite/columns.js';
import { NULL_SENTINEL } from '../drizzle/sqlite/constraints.js';
import { sqliteStorageChecks } from './checks.js';

/** One table as `buildBackendLocals` holds it (`tableFacts`). */
export interface SqliteTableFacts {
	/** The SQL table name. */
	readonly name: string;
	/** The Drizzle export other tables' facts reference it by. */
	readonly export: string;
	readonly columns: readonly ColumnFact[];
	readonly constraints: readonly ConstraintFact[];
}

const quoteSql = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A predicate / CHECK expression with columns written bare: the text is SQL already (TGT-1). */
function sqlExpression(segments: readonly PredicateSegment[]): string {
	return segments.map((s) => ('text' in s ? s.text : s.column)).join('');
}

/** The declared type. A `max_length` string says its length (`TEXT(n)`, as Drizzle declares it); SQLite does not enforce
 *  it, the length CHECK does. */
function columnType(c: ColumnFact): string {
	if (!c.isArray && (c.kind === 'integer' || c.kind === 'boolean')) return 'INTEGER';
	return !c.isArray && c.kind === 'string' && c.maxLength !== null ? `TEXT(${c.maxLength})` : 'TEXT';
}

function defaultSql(c: ColumnFact): string {
	if (c.default === null) return '';
	if ('now' in c.default) return ` DEFAULT ${sqliteNow(c.kind === 'date' ? 'date' : 'instant', c.withTimezone)}`;
	const v = c.default.value;
	if (c.kind === 'json' || c.isArray) return ` DEFAULT ${quoteSql(JSON.stringify(v))}`;
	if (typeof v === 'boolean') return ` DEFAULT ${v ? 1 : 0}`;
	if (typeof v === 'number') return ` DEFAULT ${v}`;
	return ` DEFAULT ${quoteSql(String(v))}`;
}

/**
 * A column of `table` by its property. A field `foreign_key:`'s target is the column as the YAML writes it (a known
 * TGT-1 gap: `targetProp` holds it), so a column name is accepted too.
 */
function columnOf(table: SqliteTableFacts, prop: string): string {
	const col = table.columns.find((c) => c.prop === prop) ?? table.columns.find((c) => c.name === prop);
	if (!col) throw new Error(`sqlite ddl: table '${table.name}' has no column with property '${prop}'.`);
	return col.name;
}

/** Tables in reference order; a cycle is an error naming its tables. */
function ordered(tables: readonly SqliteTableFacts[], tableOf: (exp: string, from: string) => SqliteTableFacts) {
	const deps = new Map<SqliteTableFacts, Set<SqliteTableFacts>>();
	for (const t of tables) {
		const d = new Set<SqliteTableFacts>();
		for (const c of t.constraints) {
			const target =
				c.kind === 'reference' ? c.fact.targetExport : c.kind === 'foreignKey' ? c.fact.targetExport : null;
			if (target === null) continue;
			const dep = tableOf(target, t.name);
			if (dep !== t) d.add(dep);
		}
		deps.set(t, d);
	}
	const out: SqliteTableFacts[] = [];
	const state = new Map<SqliteTableFacts, 'visiting' | 'done'>();
	const visit = (t: SqliteTableFacts, path: string[]) => {
		if (state.get(t) === 'done') return;
		if (state.get(t) === 'visiting') {
			throw new Error(`sqlite ddl: a reference cycle: ${[...path, t.name].join(' → ')}.`);
		}
		state.set(t, 'visiting');
		for (const d of deps.get(t)!) visit(d, [...path, t.name]);
		state.set(t, 'done');
		out.push(t);
	};
	for (const t of tables) visit(t, []);
	return out;
}

/** The DDL for a set of tables. Every reference must point into the set. */
export function renderSqliteDdl(tables: readonly SqliteTableFacts[]): string {
	const byExport = new Map(tables.map((t) => [t.export, t]));
	const tableOf = (exp: string, from: string) => {
		const t = byExport.get(exp);
		if (!t) throw new Error(`sqlite ddl: '${from}' references '${exp}', which is not in the set being rendered.`);
		return t;
	};
	const statements: string[] = [];
	for (const table of ordered(tables, tableOf)) {
		const refs = new Map<string, string>();
		const tableConstraints: string[] = [];
		const indexes: string[] = [];
		for (const c of table.constraints) {
			switch (c.kind) {
				case 'reference': {
					const target = tableOf(c.fact.targetExport, table.name);
					const action = c.fact.onDelete === undefined ? '' : ` ON DELETE ${c.fact.onDelete.toUpperCase()}`;
					refs.set(c.fact.column, ` REFERENCES "${target.name}"("${columnOf(target, c.fact.targetProp)}")${action}`);
					break;
				}
				case 'foreignKey': {
					const target = tableOf(c.fact.targetExport, table.name);
					const cols = c.fact.props.map((p) => `"${columnOf(table, p)}"`).join(', ');
					const targetCols = c.fact.targetProps.map((p) => `"${columnOf(target, p)}"`).join(', ');
					tableConstraints.push(
						`CONSTRAINT "${c.fact.name}" FOREIGN KEY (${cols}) REFERENCES "${target.name}"(${targetCols}) ON DELETE ${c.fact.onDelete.toUpperCase()}`,
					);
					break;
				}
				case 'check':
					tableConstraints.push(`CONSTRAINT "${c.fact.name}" CHECK (${sqlExpression(c.fact.expression)})`);
					break;
				case 'unique': {
					const u = c.fact;
					const cols = u.props
						.map((p) => (u.nullsNotDistinct ? `ifnull("${columnOf(table, p)}", ${NULL_SENTINEL})` : `"${columnOf(table, p)}"`))
						.join(', ');
					if (u.referenced) tableConstraints.push(`CONSTRAINT "${u.name}" UNIQUE (${cols})`);
					else {
						const where = u.where === null ? '' : ` WHERE ${sqlExpression(u.where)}`;
						indexes.push(`CREATE UNIQUE INDEX IF NOT EXISTS "${u.name}" ON "${table.name}" (${cols})${where};`);
					}
					break;
				}
				case 'index': {
					const cols = c.fact.props.map((p) => `"${columnOf(table, p)}"`).join(', ');
					indexes.push(`CREATE INDEX IF NOT EXISTS "${c.fact.name}" ON "${table.name}" (${cols});`);
					break;
				}
			}
		}
		for (const check of sqliteStorageChecks(table.name, table.columns)) {
			tableConstraints.push(`CONSTRAINT "${check.name}" CHECK (${sqlExpression(check.expression)})`);
		}
		const lines = table.columns.map((c) => {
			const pk = c.origin === 'id' ? ' PRIMARY KEY' : '';
			const notNull = c.origin !== 'id' && !c.nullable ? ' NOT NULL' : '';
			return `  "${c.name}" ${columnType(c)}${pk}${notNull}${defaultSql(c)}${refs.get(c.name) ?? ''}`;
		});
		statements.push(
			`CREATE TABLE IF NOT EXISTS "${table.name}" (\n${[...lines, ...tableConstraints.map((t) => `  ${t}`)].join(',\n')}\n);`,
			...indexes,
		);
	}
	return `${statements.join('\n')}\n`;
}
