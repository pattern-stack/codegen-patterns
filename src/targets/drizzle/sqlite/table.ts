/**
 * One table as a drizzle/sqlite module body (TGT-2b): the column lines and extra-config entries a `sqliteTable(…)`
 * declaration prints, and the imports it needs — all from the table's facts (`tableFacts`). The one owner of that
 * text: the sqlite entity template prints it, and the DDL ↔ Drizzle parity gate compiles exactly what it prints.
 *
 * Every column comes from `renderSqliteColumn` plus its reference suffix; every constraint from the drizzle/sqlite
 * constraint renderer, plus SQLite's storage CHECKs (`../../sqlite/checks.ts`). Hygen-safe: shipped imports only.
 */

import type { ConstraintFact } from '../../../derived/constraints/types.js';
import type { ColumnFact } from '../../../derived/tables/types.js';
import { sqliteStorageChecks } from '../../sqlite/checks.js';
import { renderSqliteColumn } from './columns.js';
import { drizzleSqliteConstraints as render } from './constraints.js';

export interface SqliteTableInput {
	readonly name: string;
	readonly export: string;
	readonly columns: readonly ColumnFact[];
	readonly constraints: readonly ConstraintFact[];
}

export interface RenderedSqliteTable {
	/** `<prop>: <chain>` per column, in declaration order. */
	readonly columns: readonly string[];
	/** The extra-config callback's entries (`index(…)`, `check(…)`, …), each with its optional comment. */
	readonly extra: readonly { readonly comment: string | null; readonly expr: string }[];
	/** The `drizzle-orm/sqlite-core` names the module imports, sorted (the table builder included). */
	readonly coreImports: readonly string[];
	/** The module needs `sql` from `drizzle-orm` (a predicate, a CHECK or a `now` default). */
	readonly usesSql: boolean;
	/** A column references another table, so the callback is annotated `AnySQLiteColumn`. */
	readonly usesAnyColumn: boolean;
	/** The other tables' exports this module references (its imports come from the composer). */
	readonly referencedExports: readonly string[];
}

export function renderSqliteTable(t: SqliteTableInput, tableParam: string): RenderedSqliteTable {
	const refs = new Map<string, string>();
	const referenced = new Set<string>();
	for (const c of t.constraints) {
		if (c.kind === 'reference') {
			refs.set(c.fact.column, render.columnReference(c.fact));
			if (c.fact.targetExport !== t.export) referenced.add(c.fact.targetExport);
		} else if (c.kind === 'foreignKey' && c.fact.targetExport !== t.export) {
			referenced.add(c.fact.targetExport);
		}
	}
	const builders = new Set<string>(['sqliteTable']);
	const columns = t.columns.map((c) => {
		const r = renderSqliteColumn(c);
		builders.add(r.drizzleType);
		return `${c.prop}: ${r.drizzleChain}${refs.get(c.name) ?? ''}`;
	});
	const extra: { comment: string | null; expr: string }[] = [];
	for (const c of t.constraints) {
		if (c.kind === 'index') {
			builders.add('index');
			extra.push({ comment: null, expr: render.index(c.fact, tableParam) });
		} else if (c.kind === 'unique') {
			const u = render.unique(c.fact, tableParam);
			builders.add(u.builder);
			extra.push({ comment: u.comment, expr: u.expr });
		} else if (c.kind === 'foreignKey') {
			builders.add('foreignKey');
			extra.push({ comment: null, expr: render.foreignKey(c.fact, tableParam) });
		} else if (c.kind === 'check') {
			builders.add('check');
			extra.push({ comment: null, expr: render.check(c.fact, tableParam) });
		}
	}
	for (const c of sqliteStorageChecks(t.name, t.columns)) {
		builders.add('check');
		extra.push({ comment: null, expr: render.check(c, tableParam) });
	}
	const text = [...columns, ...extra.map((e) => e.expr)].join('\n');
	return {
		columns,
		extra,
		coreImports: [...builders].sort(),
		usesSql: text.includes('sql`'),
		usesAnyColumn: refs.size > 0,
		referencedExports: [...referenced].sort(),
	};
}
