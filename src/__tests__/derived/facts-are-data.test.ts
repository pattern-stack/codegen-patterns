/**
 * TGT-2b, ADR-047's rule: facts can come from rows as well as YAML. A later interpreted mode would define domains as
 * data and build Zod, Drizzle tables and DDL at runtime from the same facts, so facts must be plain data:
 * JSON-serializable, with no functions, class instances or template text. Renderers must read nothing else.
 *
 * Over the baseline set: each table's facts survive a JSON round trip unchanged, and every renderer writes the same
 * bytes from the round-tripped copy as from the original. A fact that sneaks in a function, a Map, a Date or an
 * `undefined`-that-means-something fails here.
 */

import { describe, expect, it } from 'bun:test';
import { baselineSet } from './_inputs';
import { backendLocalsFor } from './_render';
import type { ConstraintFact } from '../../derived/constraints/types';
import { drizzlePostgresConstraints as pg } from '../../targets/drizzle/postgres/constraints';
import { renderSqliteTable } from '../../targets/drizzle/sqlite/table';
import { renderSqliteDdl, type SqliteTableFacts } from '../../targets/sqlite/ddl';

const set = baselineSet();
const tables = set.entities.map((d) => backendLocalsFor(set, d.entity.name).tableFacts as SqliteTableFacts);

/** Every constraint as Postgres writes it — the other pair's renderer, over the same facts. */
function postgresText(t: SqliteTableFacts): string[] {
	return t.constraints.map((c: ConstraintFact) => {
		switch (c.kind) {
			case 'reference':
				return pg.columnReference(c.fact);
			case 'index':
				return pg.index(c.fact, 'tCols');
			case 'unique':
				return pg.unique(c.fact, 'tCols').expr;
			case 'foreignKey':
				return pg.foreignKey(c.fact, 'tCols');
			case 'check':
				return pg.check(c.fact, 'tCols');
		}
	});
}

describe('facts are data (ADR-047: facts can come from rows as well as YAML)', () => {
	it.each(tables.map((t) => [t.name, t] as const))('%s survives a JSON round trip unchanged', (_n, t) => {
		// Strict: an `undefined`-valued key (which JSON drops) is a difference, not an equal.
		expect(JSON.parse(JSON.stringify(t))).toStrictEqual(t);
	});

	it.each(tables.map((t) => [t.name, t] as const))('%s renders the same bytes from its round-tripped facts', (_n, t) => {
		const copy = JSON.parse(JSON.stringify(t)) as SqliteTableFacts;
		expect(renderSqliteDdl([copy])).toBe(renderSqliteDdl([t]));
		expect(renderSqliteTable(copy, 'tCols')).toEqual(renderSqliteTable(t, 'tCols'));
		expect(postgresText(copy)).toEqual(postgresText(t));
	});

	it('no fact value is a function, a class instance or template text', () => {
		const visit = (v: unknown, path: string): void => {
			if (typeof v === 'function') throw new Error(`${path} is a function`);
			if (v !== null && typeof v === 'object') {
				const proto = Object.getPrototypeOf(v);
				if (proto !== Object.prototype && proto !== Array.prototype) throw new Error(`${path} is a ${proto?.constructor?.name}`);
				for (const [k, child] of Object.entries(v)) visit(child, `${path}.${k}`);
			}
			if (typeof v === 'string' && /\$\{|sql`|\bpgTable\b|\bsqliteTable\b|\.notNull\(\)/.test(v)) {
				throw new Error(`${path} holds template text: ${v}`);
			}
		};
		for (const t of tables) expect(() => visit(t, t.name)).not.toThrow();
	});
});
