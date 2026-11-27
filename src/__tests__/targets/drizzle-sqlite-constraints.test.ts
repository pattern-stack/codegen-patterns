/**
 * TGT-2a: the drizzle/sqlite constraint renderer's exact text per constraint shape, and the storage CHECKs SQLite
 * needs where Postgres enforces through a type (enum, max_length).
 */

import { describe, expect, it } from 'bun:test';
import { deriveFieldFacts } from '../../derived/columns/fields';
import { fieldColumn } from '../../derived/tables/columns';
import { drizzleSqliteConstraints as sqlite } from '../../targets/drizzle/sqlite/constraints';
import { sqliteStorageChecks } from '../../targets/sqlite/checks';

const base = { name: 'n', props: ['a', 'b'], where: null, nullsNotDistinct: false, referenced: false, tenantScoped: false };

describe('drizzle/sqlite constraints', () => {
	it('a column reference is annotated AnySQLiteColumn, with the referential action', () => {
		expect(sqlite.columnReference({ column: 'account_id', targetExport: 'accounts', targetProp: 'id', onDelete: 'cascade' })).toBe(
			".references((): AnySQLiteColumn => accounts.id, { onDelete: 'cascade' })",
		);
		expect(sqlite.columnReference({ column: 'account_id', targetExport: 'accounts', targetProp: 'id' })).toBe(
			'.references((): AnySQLiteColumn => accounts.id)',
		);
	});

	it('uniques: plain, partial, referenced; NULLS NOT DISTINCT as an ifnull(…, X\'00\') expression index', () => {
		expect(sqlite.unique(base, 'tCols')).toEqual({ builder: 'uniqueIndex', expr: "uniqueIndex('n').on(tCols.a, tCols.b)", comment: null });
		expect(sqlite.unique({ ...base, where: [{ column: 'deleted_at', prop: 'deletedAt' }, { text: ' IS NULL' }] }, 'tCols').expr).toBe(
			"uniqueIndex('n').on(tCols.a, tCols.b).where(sql`${tCols.deletedAt} IS NULL`)",
		);
		expect(sqlite.unique({ ...base, referenced: true }, 'tCols')).toEqual({ builder: 'unique', expr: "unique('n').on(tCols.a, tCols.b)", comment: null });
		expect(sqlite.unique({ ...base, nullsNotDistinct: true, tenantScoped: true }, 'tCols').expr).toBe(
			"uniqueIndex('n').on(sql`ifnull(${tCols.a}, X'00')`, sql`ifnull(${tCols.b}, X'00')`)",
		);
		expect(() => sqlite.unique({ ...base, nullsNotDistinct: true, where: [{ text: 'true' }] }, 'tCols')).toThrow(/partial/);
	});

	it('index, foreign key and check share Drizzle’s spelling with Postgres', () => {
		expect(sqlite.index({ name: 'i', props: ['a'] }, 'tCols')).toBe("index('i').on(tCols.a)");
		expect(
			sqlite.foreignKey({ name: 'f', props: ['id', 'kind'], targetExport: 'bases', targetProps: ['id', 'kind'], onDelete: 'cascade' }, 'tCols'),
		).toBe("foreignKey({\n      name: 'f',\n      columns: [tCols.id, tCols.kind],\n      foreignColumns: [bases.id, bases.kind],\n    }).onDelete('cascade')");
		expect(sqlite.check({ name: 'c', expression: [{ column: 'kind', prop: 'kind' }, { text: " = 'meeting'" }] }, 'tCols')).toBe(
			"check('c', sql`${tCols.kind} = 'meeting'`)",
		);
	});
});

describe('sqliteStorageChecks', () => {
	const cols = deriveFieldFacts(
		{
			status: { type: 'enum', choices: ['open', "won't"] },
			title: { type: 'string', max_length: 80 },
			body: { type: 'string' },
			tags: { type: 'string_array' },
		},
		'note',
		null,
	).map((f) => fieldColumn(f));

	it('an enum gets IN (…) (SQL-quoted), a max_length string gets length(…) <= n; nothing else', () => {
		const checks = sqliteStorageChecks('notes', cols);
		expect(checks.map((c) => c.name)).toEqual(['notes_status_in', 'notes_title_len']);
		expect(sqlite.check(checks[0]!, 'tCols')).toBe("check('notes_status_in', sql`${tCols.status} IN ('open', 'won''t')`)");
		expect(sqlite.check(checks[1]!, 'tCols')).toBe("check('notes_title_len', sql`length(${tCols.title}) <= 80`)");
	});

	it('a child’s inherited kind has none (its RFC-0006 kind CHECK already fixes it)', () => {
		const kind = { ...cols[0]!, name: 'kind', prop: 'kind', origin: 'inherited' as const, choices: ['meeting'] };
		expect(sqliteStorageChecks('notes', [kind])).toEqual([]);
	});
});
