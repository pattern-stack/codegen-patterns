/**
 * TGT-2b smoke: a `target: { database: sqlite, orm: drizzle }` project, end to end, over the whole baseline fixture
 * set (tenant-scoped entities and the joined-table family included).
 *
 * 1. `entity new --all` through the real CLI writes the storage layer — a `sqliteTable` module and an `<entity>.sql`
 *    per entity, the schema barrel — and nothing of the Nest layers, saying so.
 * 2. `tsc` over the emitted tree: no diagnostic located in the project (`_consumer-errors.ts`, by location only).
 * 3. Every emitted `.sql` applies to `bun:sqlite` with foreign keys on, and applies again.
 * 4. Through `drizzle-orm/sqlite-proxy` over a positional handle (crew's `SqlHandle` shape), using the GENERATED
 *    table modules: every table selects every declared column (the module and the applied DDL agree on names), and a
 *    row round-trips through one table.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { consumerErrors } from '../smoke/_consumer-errors';

const REPO = resolve(import.meta.dir, '../..');
// Inside the repo so the emitted modules resolve drizzle-orm from its node_modules.
const PROJECT = join(REPO, 'node_modules/.cache', `sqlite-smoke-${process.pid}`);
afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

mkdirSync(PROJECT, { recursive: true });
cpSync(join(REPO, 'test/fixtures/entities'), join(PROJECT, 'entities'), { recursive: true });
writeFileSync(
	join(PROJECT, 'codegen.config.yaml'),
	'runtime: vendored\ntarget:\n  database: sqlite\n  orm: drizzle\npaths:\n  backend_src: src\n  entities: entities\n',
);
const gen = spawnSync('bun', [join(REPO, 'src/cli/index.ts'), 'entity', 'new', '--all', '--cwd', PROJECT], {
	cwd: REPO,
	encoding: 'utf-8',
});

const walk = (dir: string): string[] =>
	existsSync(dir)
		? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
		: [];
const emitted = walk(join(PROJECT, 'src'));
const entityNames = readdirSync(join(PROJECT, 'entities')).filter((f) => f.endsWith('.yaml'));

describe('a SQLite project, generated', () => {
	it('entity new --all succeeds and says what it skipped', () => {
		expect(gen.status).toBe(0);
		expect(gen.stdout).toContain('target sqlite: storage layer only');
		expect(gen.stdout).toContain('they come with wiring: pattern-stack (G7)');
	});

	it('the dry run predicts the same: the storage layer only, exit 0', () => {
		const dry = spawnSync('bun', [join(REPO, 'src/cli/index.ts'), 'entity', 'new', '--all', '--dry-run', '--cwd', PROJECT], {
			cwd: REPO,
			encoding: 'utf-8',
		});
		expect(dry.status).toBe(0);
		expect(dry.stdout).toContain('[dry run] target sqlite: storage layer only');
	});

	it.each(['junction', 'relationship'])('%s new refuses a storage-only target by name', (noun) => {
		const r = spawnSync('bun', [join(REPO, 'src/cli/index.ts'), noun, 'new', '--all', '--cwd', PROJECT], {
			cwd: REPO,
			encoding: 'utf-8',
		});
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain(`${noun} new: target sqlite emits the storage layer only`);
		expect(existsSync(join(PROJECT, 'src/generated/modules.ts'))).toBe(false);
	});

	it('writes the storage layer — a table module and a .sql per entity, the schema barrel — and no Nest layer', () => {
		const modules = emitted.filter((f) => f.endsWith('.entity.ts'));
		const sql = emitted.filter((f) => f.endsWith('.sql'));
		expect(modules.length).toBe(entityNames.length);
		expect(sql.length).toBe(entityNames.length);
		expect(existsSync(join(PROJECT, 'src/generated/schema.ts'))).toBe(true);
		const nest = emitted.filter((f) => /\.(repository|service|controller|module|dto|use-case|enums)\.ts$/.test(f));
		expect(nest).toEqual([]);
		for (const m of modules) expect(readFileSync(m, 'utf-8')).toContain("from 'drizzle-orm/sqlite-core'");
	});

	it('typechecks', () => {
		writeFileSync(
			join(PROJECT, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, noEmit: true, lib: ['ES2022', 'DOM'] },
				include: ['src/**/*.ts'],
			}),
		);
		const tsc = spawnSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: PROJECT, encoding: 'utf-8' });
		// tsc must have run (a missing binary prints no diagnostic) and found nothing in the project.
		expect(tsc.error).toBeUndefined();
		expect(tsc.status).toBe(0);
		expect(consumerErrors(`${tsc.stdout}${tsc.stderr}`)).toEqual([]);
	});

	const ddl = emitted.filter((f) => f.endsWith('.sql')).map((f) => readFileSync(f, 'utf-8')).join('\n');

	it('every .sql applies with foreign keys on, and applies again', () => {
		const db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		db.exec(ddl);
		db.exec(ddl);
		expect(db.query("SELECT count(*) FROM sqlite_master WHERE type = 'table'").values()[0]![0]).toBe(entityNames.length);
	});

	it('the generated modules read and write the applied schema through sqlite-proxy', async () => {
		const raw = new Database(':memory:');
		raw.exec(ddl);
		const db = drizzle(async (q, params, method) => {
			if (method === 'run') {
				raw.query(q).run(...(params as never[]));
				return { rows: [] };
			}
			const rows = raw.query(q).values(...(params as never[]));
			return { rows: method === 'get' ? (rows[0] ?? undefined) : rows } as { rows: unknown[] };
		});
		const schema = (await import(join(PROJECT, 'src/generated/schema.ts'))) as Record<string, unknown>;
		const tables = Object.entries(schema).filter(([, v]) => v && typeof v === 'object' && Symbol.for('drizzle:IsDrizzleTable') in (v as object));
		expect(tables.length).toBe(entityNames.length);
		// Every declared column, every table: a name the module declares and the DDL lacks fails here.
		for (const [, table] of tables) expect(await db.select().from(table as never).all()).toEqual([]);
		// A row through one table: the app-made id, a TEXT ISO default, the shape the module types.
		const { tenants } = schema as { tenants: never };
		const [row] = await db.insert(tenants).values({ name: 'acme' } as never).returning();
		expect((row as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await db.select().from(tenants).all()).toEqual([row]);
	});
});
