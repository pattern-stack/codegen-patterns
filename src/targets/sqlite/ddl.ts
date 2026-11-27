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
 * - A reference carries its target's SQL table and column (TGT-2b), so one table's DDL needs no other table's facts:
 *   `<entity>.sql` per entity references tables created by their own files.
 * - Tables are written in reference order where there is one. Two tables that reference each other (#631's case) are
 *   written in declaration order: SQLite checks a foreign key when a row is written, not when a table is created.
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

/**
 * A predicate / CHECK expression: the text is SQL already (TGT-1), and a column is quoted, as drizzle-kit quotes it,
 * so a column named by a keyword (`order`, `group`) parses. An author's `where:` is copied as written, so on SQLite it
 * must be SQLite SQL (no `::text`, no `ILIKE`).
 */
function sqlExpression(segments: readonly PredicateSegment[]): string {
	return segments.map((s) => ('text' in s ? s.text : `"${s.column}"`)).join('');
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
	if (c.kind !== 'decimal' && typeof v === 'boolean') return ` DEFAULT ${v ? 1 : 0}`;
	if (c.kind !== 'decimal' && typeof v === 'number') return ` DEFAULT ${v}`;
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

/**
 * Tables in reference order, among the tables being rendered; within a cycle, in declaration order (SQLite resolves
 * FKs at write time). A reference to a table outside the set is not a dependency here.
 */
function ordered(tables: readonly SqliteTableFacts[]) {
	const byName = new Map(tables.map((t) => [t.name, t]));
	const deps = new Map<SqliteTableFacts, Set<SqliteTableFacts>>();
	for (const t of tables) {
		const d = new Set<SqliteTableFacts>();
		for (const c of t.constraints) {
			const target = c.kind === 'reference' || c.kind === 'foreignKey' ? c.fact.targetTable : null;
			const dep = target === null ? undefined : byName.get(target);
			if (dep && dep !== t) d.add(dep);
		}
		deps.set(t, d);
	}
	const out: SqliteTableFacts[] = [];
	const state = new Map<SqliteTableFacts, 'visiting' | 'done'>();
	const visit = (t: SqliteTableFacts, path: string[]) => {
		if (state.get(t) === 'done') return;
		if (state.get(t) === 'visiting') return;
		state.set(t, 'visiting');
		for (const d of deps.get(t)!) visit(d, [...path, t.name]);
		state.set(t, 'done');
		out.push(t);
	};
	for (const t of tables) visit(t, []);
	return out;
}

/** The DDL for a set of tables (one entity's, or a whole module's). */
export function renderSqliteDdl(tables: readonly SqliteTableFacts[]): string {
	const statements: string[] = [];
	for (const table of ordered(tables)) {
		const refs = new Map<string, string>();
		const tableConstraints: string[] = [];
		const indexes: string[] = [];
		for (const c of table.constraints) {
			switch (c.kind) {
				case 'reference': {
					const action = c.fact.onDelete === undefined ? '' : ` ON DELETE ${c.fact.onDelete.toUpperCase()}`;
					refs.set(c.fact.column, ` REFERENCES "${c.fact.targetTable}"("${c.fact.targetColumn}")${action}`);
					break;
				}
				case 'foreignKey': {
					const cols = c.fact.columns.map((n) => `"${n}"`).join(', ');
					const targetCols = c.fact.targetColumns.map((n) => `"${n}"`).join(', ');
					tableConstraints.push(
						`CONSTRAINT "${c.fact.name}" FOREIGN KEY (${cols}) REFERENCES "${c.fact.targetTable}"(${targetCols}) ON DELETE ${c.fact.onDelete.toUpperCase()}`,
					);
					break;
				}
				case 'check':
					tableConstraints.push(`CONSTRAINT "${c.fact.name}" CHECK (${sqlExpression(c.fact.expression)})`);
					break;
				case 'unique': {
					const u = c.fact;
					// The drizzle/sqlite renderer's decision order, and its refusals.
					if (u.nullsNotDistinct && (u.where !== null || u.referenced)) {
						throw new Error(
							`sqlite ddl: '${table.name}' unique '${u.name}': NULLS NOT DISTINCT is an expression index, so it cannot also be ${u.where !== null ? 'partial' : 'referenced by a foreign key'}.`,
						);
					}
					if (u.referenced && u.where !== null) {
						throw new Error(`sqlite ddl: '${table.name}' unique '${u.name}': a foreign key's target cannot be partial.`);
					}
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
			// The id is NOT NULL too: SQLite lets a non-INTEGER primary key hold NULL, more than once.
			const pk = c.origin === 'id' ? ' PRIMARY KEY' : '';
			const notNull = c.origin === 'id' || !c.nullable ? ' NOT NULL' : '';
			return `  "${c.name}" ${columnType(c)}${pk}${notNull}${defaultSql(c)}${refs.get(c.name) ?? ''}`;
		});
		statements.push(
			`CREATE TABLE IF NOT EXISTS "${table.name}" (\n${[...lines, ...tableConstraints.map((t) => `  ${t}`)].join(',\n')}\n);`,
			...indexes,
		);
	}
	return `${statements.join('\n')}\n`;
}
