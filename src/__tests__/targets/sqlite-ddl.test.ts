/**
 * TGT-2a (G9): `renderSqliteDdl` over the baseline fixture set — every entity, the joined-table family included —
 * pinned as a golden, applied to a real `bun:sqlite` database with foreign keys on, and its SQLite-only rules
 * (NULLS NOT DISTINCT, enum / length CHECKs) shown to hold on real rows.
 *
 * Regenerate the golden with `UPDATE_SQLITE_DDL_GOLDEN=1 bun test src/__tests__/targets/sqlite-ddl.test.ts`.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, baselineSet } from '../derived/_inputs';
import { backendLocalsFor } from '../derived/_render';
import { renderSqliteDdl, type SqliteTableFacts } from '../../targets/sqlite/ddl';

const GOLDEN = join(REPO_ROOT, 'test/sqlite-ddl-golden/baseline.sql');

export function baselineTables(): SqliteTableFacts[] {
	const set = baselineSet();
	return set.entities.map((d) => backendLocalsFor(set, d.entity.name).tableFacts as SqliteTableFacts);
}

const ddl = renderSqliteDdl(baselineTables());

describe('the baseline set as SQLite DDL', () => {
	it('matches the golden', () => {
		if (process.env.UPDATE_SQLITE_DDL_GOLDEN === '1') {
			mkdirSync(dirname(GOLDEN), { recursive: true });
			writeFileSync(GOLDEN, ddl);
		}
		expect(existsSync(GOLDEN)).toBe(true);
		expect(ddl).toBe(readFileSync(GOLDEN, 'utf-8'));
	});

	it('applies to a real database with foreign keys on, and applies again (IF NOT EXISTS)', () => {
		const db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		db.exec(ddl);
		db.exec(ddl);
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").values().flat();
		expect(tables).toEqual(baselineTables().map((t) => t.name).sort());
		expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
	});
});

describe('the table facts agree with the YAML they came from (a check independent of both renderings)', () => {
	const KIND: Record<string, string> = {
		string: 'string', integer: 'integer', decimal: 'decimal', boolean: 'boolean', uuid: 'uuid',
		date: 'date', datetime: 'instant', json: 'json', string_array: 'string',
	};
	const set = baselineSet();
	it.each(set.entities.map((d) => [d.entity.name, d] as const))('%s', (name, d) => {
		const facts = backendLocalsFor(set, name).tableFacts as SqliteTableFacts;
		for (const [fieldName, raw] of Object.entries((d as { fields?: Record<string, any> }).fields ?? {})) {
			const col = facts.columns.find((c) => c.name === fieldName && c.origin === 'field');
			if (!col) continue; // a belongs_to FK field is the belongs_to column
			const want = raw.choices || raw.choices_of ? 'enum' : (KIND[raw.type ?? 'string'] ?? 'string');
			expect(`${fieldName}:${col.kind}`).toBe(`${fieldName}:${want}`);
			expect(`${fieldName}:${col.isArray}`).toBe(`${fieldName}:${raw.type === 'string_array'}`);
			if (raw.default !== undefined) expect(col.default).toEqual(raw.default === 'now' ? { now: true } : { value: raw.default });
		}
	});
});

describe('SQLite-only rules, on rows', () => {
	const fact = (over: Partial<SqliteTableFacts> = {}): SqliteTableFacts => ({
		name: 'items',
		export: 'items',
		columns: [
			{ name: 'id', prop: 'id', path: ['id'], origin: 'id', kind: 'uuid', isArray: false, nullable: false, default: null, choices: null, maxLength: null, withTimezone: null, generatedId: true },
			{ name: 'tenant_id', prop: 'tenantId', path: ['tenant_id'], origin: 'tenant', kind: 'uuid', isArray: false, nullable: true, default: null, choices: null, maxLength: null, withTimezone: null, generatedId: false },
			{ name: 'code', prop: 'code', path: ['code'], origin: 'field', kind: 'string', isArray: false, nullable: false, default: null, choices: null, maxLength: 4, withTimezone: null, generatedId: false },
			{ name: 'state', prop: 'state', path: ['state'], origin: 'field', kind: 'enum', isArray: false, nullable: false, default: { value: 'open' }, choices: ['open', 'shut'], maxLength: null, withTimezone: null, generatedId: false },
		],
		constraints: [
			{
				kind: 'unique',
				fact: { name: 'items_tenant_id_code_uniq', props: ['tenantId', 'code'], where: null, nullsNotDistinct: true, referenced: false, tenantScoped: true },
			},
		],
		...over,
	});
	const open = () => {
		const db = new Database(':memory:');
		db.exec(renderSqliteDdl([fact()]));
		return db;
	};
	const insert = (db: Database, id: string, tenant: string | null, code: string, state?: string) =>
		state === undefined
			? db.query('INSERT INTO items (id, tenant_id, code) VALUES (?, ?, ?)').run(id, tenant, code)
			: db.query('INSERT INTO items (id, tenant_id, code, state) VALUES (?, ?, ?, ?)').run(id, tenant, code, state);

	it('NULLS NOT DISTINCT: two NULL-tenant rows with one code conflict; tenants keep their own codes', () => {
		const db = open();
		insert(db, 'a', null, 'x');
		expect(() => insert(db, 'b', null, 'x')).toThrow(/UNIQUE constraint failed/);
		insert(db, 'c', 't1', 'x');
		insert(db, 'd', 't2', 'x');
		expect(() => insert(db, 'e', 't1', 'x')).toThrow(/UNIQUE constraint failed/);
	});

	it('an upsert targets the NULLS NOT DISTINCT index by its expressions (TGT-2b’s ON CONFLICT)', () => {
		const db = open();
		const upsert = db.query(
			`INSERT INTO items (id, tenant_id, code, state) VALUES (?, ?, ?, ?)
			 ON CONFLICT (ifnull("tenant_id", X'00'), ifnull("code", X'00')) DO UPDATE SET state = excluded.state`,
		);
		upsert.run('a', null, 'x', 'open');
		upsert.run('b', null, 'x', 'shut');
		expect(db.query('SELECT id, state FROM items').values()).toEqual([['a', 'shut']]);
	});

	it('the id is NOT NULL (SQLite lets a TEXT primary key be NULL otherwise)', () => {
		const db = open();
		expect(() => db.query("INSERT INTO items (code) VALUES ('x')").run()).toThrow(/NOT NULL/);
	});

	it('the enum CHECK, the length CHECK and the enum default', () => {
		const db = open();
		insert(db, 'a', null, 'ok');
		expect(db.query("SELECT state FROM items WHERE id = 'a'").values()).toEqual([['open']]);
		expect(() => insert(db, 'b', null, 'ok2', 'gone')).toThrow(/CHECK constraint failed/);
		expect(() => insert(db, 'c', null, 'toolong')).toThrow(/CHECK constraint failed/);
	});

	it('a reference outside the set is an error naming it; a cycle (#631) renders, and applies', () => {
		const ref = (from: string, to: string) => ({ kind: 'reference' as const, fact: { column: 'id', targetExport: to, targetProp: 'id' } });
		expect(() => renderSqliteDdl([fact({ constraints: [ref('items', 'ghosts')] })])).toThrow(/'items' references 'ghosts'/);
		const cyclic = renderSqliteDdl([
			fact({ name: 'a', export: 'a', constraints: [ref('a', 'b')] }),
			fact({ name: 'b', export: 'b', constraints: [ref('b', 'a')] }),
		]);
		const db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		db.exec(cyclic);
		expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").values().flat()).toEqual(['a', 'b']);
	});
});
