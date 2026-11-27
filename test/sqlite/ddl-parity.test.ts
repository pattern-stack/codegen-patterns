/**
 * TGT-2a parity gate: two independent renderings of the same table facts build the same SQLite schema.
 *
 * 1. The drizzle/sqlite renderers write a `sqlite-core` module for every baseline table (assembled here, the way the
 *    TGT-2b template will), and drizzle-kit's own `generate` turns it into SQL.
 * 2. `renderSqliteDdl` writes the DDL directly.
 *
 * Both are applied to fresh `bun:sqlite` databases and compared through SQLite's own catalogue, per table: columns
 * (`table_info`: type, NOT NULL, default, primary key), foreign keys (`foreign_key_list`), indexes (`index_list` +
 * `index_xinfo`: unique, partial, key columns or expressions), every index's SQL (so an expression or a `WHERE`
 * differs visibly) and every CHECK's body. A fact one renderer writes and the other doesn't fails here, naming the
 * table.
 *
 * Normalised on purpose, and only this: a primary key's NOT NULL (drizzle-kit omits it; see `catalogue`), type and
 * default spelling (`text` / `TEXT`, `false` / `0`), SQLite's
 * auto-index names (a UNIQUE constraint's index is named by its position), and in SQL text: identifier quotes,
 * whitespace, case and `IF NOT EXISTS`.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baselineSet } from '../../src/__tests__/derived/_inputs';
import { backendLocalsFor } from '../../src/__tests__/derived/_render';
import type { ConstraintFact } from '../../src/derived/constraints/types';
import { renderSqliteColumn } from '../../src/targets/drizzle/sqlite/columns';
import { drizzleSqliteConstraints as pg } from '../../src/targets/drizzle/sqlite/constraints';
import { sqliteStorageChecks } from '../../src/targets/sqlite/checks';
import { renderSqliteDdl, type SqliteTableFacts } from '../../src/targets/sqlite/ddl';

const REPO = resolve(import.meta.dir, '../..');
// Inside the repo, so the schema module resolves `drizzle-orm` from its node_modules.
const WORK = join(REPO, 'node_modules/.cache', `sqlite-parity-${process.pid}`);
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const set = baselineSet();
const tables: SqliteTableFacts[] = set.entities.map((d) => backendLocalsFor(set, d.entity.name).tableFacts as SqliteTableFacts);

/** One table as a `sqlite-core` declaration, from the drizzle/sqlite renderers. */
function drizzleTable(t: SqliteTableFacts): string {
	const refs = new Map(
		t.constraints
			.filter((c): c is Extract<ConstraintFact, { kind: 'reference' }> => c.kind === 'reference')
			.map((c) => [c.fact.column, pg.columnReference(c.fact)]),
	);
	const cols = t.columns.map((c) => `    ${c.prop}: ${renderSqliteColumn(c).drizzleChain}${refs.get(c.name) ?? ''},`);
	const extra: string[] = [];
	for (const c of t.constraints) {
		if (c.kind === 'index') extra.push(pg.index(c.fact, 'tCols'));
		else if (c.kind === 'unique') extra.push(pg.unique(c.fact, 'tCols').expr);
		else if (c.kind === 'foreignKey') extra.push(pg.foreignKey(c.fact, 'tCols'));
		else if (c.kind === 'check') extra.push(pg.check(c.fact, 'tCols'));
	}
	for (const c of sqliteStorageChecks(t.name, t.columns)) extra.push(pg.check(c, 'tCols'));
	return (
		`export const ${t.export} = sqliteTable('${t.name}', {\n${cols.join('\n')}\n  }, (tCols) => [\n` +
		extra.map((e) => `    ${e},`).join('\n') +
		'\n  ]);\n'
	);
}

function drizzleKitSql(): string {
	mkdirSync(WORK, { recursive: true });
	const schema = join(WORK, 'schema.ts');
	writeFileSync(
		schema,
		"import { sql } from 'drizzle-orm';\n" +
			"import { check, foreignKey, index, integer, sqliteTable, text, unique, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';\n\n" +
			tables.map(drizzleTable).join('\n'),
	);
	const out = join(WORK, 'out');
	const r = spawnSync(join(REPO, 'node_modules/.bin/drizzle-kit'), ['generate', '--dialect=sqlite', `--schema=${schema}`, `--out=${out}`], {
		cwd: REPO,
		encoding: 'utf-8',
	});
	if (r.status !== 0) throw new Error(`drizzle-kit generate failed:\n${r.stdout}\n${r.stderr}`);
	const [migration] = readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory());
	return readFileSync(join(out, migration!.name, 'migration.sql'), 'utf-8').replaceAll('--> statement-breakpoint', '');
}

type Catalogue = Record<string, unknown>;

/** Every `CHECK (…)` body in a CREATE TABLE statement, by balanced parentheses (quoted text skipped). */
function checkBodies(sql: string): string[] {
	const out: string[] = [];
	const re = /\bCHECK\s*\(/gi;
	for (let m = re.exec(sql); m; m = re.exec(sql)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		let quote: string | null = null;
		for (; i < sql.length && depth > 0; i++) {
			const ch = sql[i]!;
			if (quote) {
				if (ch === quote) quote = null;
			} else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
			else if (ch === '(') depth++;
			else if (ch === ')') depth--;
		}
		out.push(sql.slice(start, i - 1));
	}
	return out;
}

/** A table as SQLite's catalogue describes it, normalised (see the header). */
function catalogue(db: Database, table: string): Catalogue {
	const norm = (v: unknown) => (v === 'false' ? '0' : v === 'true' ? '1' : v);
	const columns = db
		.query(`PRAGMA table_info("${table}")`)
		.all()
				// drizzle-kit drops NOT NULL from a SQLite primary key even when the column says `.notNull()` (found here); the DDL,
		// which is what a consumer applies, keeps it (SQLite lets a TEXT primary key hold NULL otherwise). The one
		// normalisation of a real difference, named: a primary-key column's notnull is not compared.
		.map((c: any) => ({ name: c.name, type: String(c.type).toUpperCase(), notnull: c.pk ? 'pk' : c.notnull, dflt: norm(c.dflt_value), pk: c.pk }));
	const foreignKeys = db
		.query(`PRAGMA foreign_key_list("${table}")`)
		.all()
		.map((f: any) => `${f.id}:${f.seq} ${f.from} → ${f.table}.${f.to} ${f.on_delete}`)
		.sort();
	const indexes = db
		.query(`PRAGMA index_list("${table}")`)
		.all()
		.map((i: any) => {
			const keys = db
				.query(`PRAGMA index_xinfo("${i.name}")`)
				.all()
				.filter((k: any) => k.key === 1)
				.map((k: any) => (k.cid === -2 ? 'expr' : k.name));
			const name = String(i.name).startsWith('sqlite_autoindex_') ? '(auto)' : i.name;
			return `${name} unique=${i.unique} partial=${i.partial} origin=${i.origin} [${keys.join(', ')}]`;
		})
		.sort();
	const sqlText = (s: string) => s.replace(/["`]/g, '').replace(/if not exists/gi, '').replace(/\s+/g, '').toLowerCase();
	const sql = String((db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as any).sql);
	const checks = checkBodies(sql).map(sqlText).sort();
	const indexSql = db
		.query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`)
		.values(table)
		.map(([s]) => sqlText(String(s)))
		.sort();
	return { columns, foreignKeys, indexes, indexSql, checks };
}

describe('SQLite DDL ↔ drizzle/sqlite parity, over the baseline set', () => {
	const fromDdl = new Database(':memory:');
	fromDdl.exec(renderSqliteDdl(tables));
	const fromDrizzle = new Database(':memory:');
	fromDrizzle.exec(drizzleKitSql());

	it.each(tables.map((t) => [t.name]))('%s', (name) => {
		expect(catalogue(fromDrizzle, name)).toEqual(catalogue(fromDdl, name));
	});

	it('both hold exactly the set’s tables', () => {
		const names = (db: Database) =>
			db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").values().flat();
		expect(names(fromDrizzle)).toEqual(names(fromDdl));
	});
});
