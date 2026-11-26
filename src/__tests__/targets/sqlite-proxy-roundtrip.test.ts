/**
 * TGT-2a spike (commit 1): Drizzle runs on a transaction handle shaped like crew's `SqlHandle`, through
 * `drizzle-orm/sqlite-proxy`, and every SQLite storage kind the `drizzle/sqlite` renderer will emit round-trips.
 *
 * The handle copies crew's interface (branch `sqlhandle-values` @734ceba) rather than importing crew: `run` for
 * statements and `values` for rows as positional arrays, in the statement's column order. sqlite-proxy reads rows by
 * position, so `values` is the whole reason this works. If a mode or the positional mapping misbehaves, this file
 * fails before anything is built on the assumption.
 *
 * The table and its DDL are written by hand here; the renderers that will write them come in later commits, and the
 * parity gate holds those to the same shapes.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { check, integer, numeric, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The SQLite error a statement fails with. Drizzle's builders are thenables (not promises), and Drizzle wraps the
 * driver's error in a "Failed query" error whose `cause` is SQLite's own.
 */
async function sqliteError(q: PromiseLike<unknown>): Promise<string> {
	try {
		await q;
	} catch (err) {
		const e = err as Error & { cause?: Error };
		return e.cause?.message ?? e.message;
	}
	throw new Error('expected the statement to fail');
}
import { drizzle } from 'drizzle-orm/sqlite-proxy';

type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** crew's `SqlHandle`, the two methods sqlite-proxy needs. */
interface SqlHandle {
	run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
	values(sql: string, ...params: SqlValue[]): Promise<SqlValue[][]>;
}

function handleOver(db: Database): SqlHandle {
	return {
		async run(q, ...params) {
			return { changes: db.query(q).run(...(params as never[])).changes };
		},
		async values(q, ...params) {
			return db.query(q).values(...(params as never[])) as SqlValue[][];
		},
	};
}

/** The mapping crew's generated store will use: all/values → values, get → its first row, run → run. */
function drizzleOver(handle: SqlHandle) {
	return drizzle(async (q, params, method) => {
		const p = params as SqlValue[];
		if (method === 'run') {
			await handle.run(q, ...p);
			return { rows: [] };
		}
		const rows = await handle.values(q, ...p);
		return { rows: method === 'get' ? (rows[0] ?? undefined) : rows } as { rows: unknown[] };
	});
}

const ISO_NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

const notes = sqliteTable(
	'notes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		title: text('title', { length: 20 }).notNull(),
		count: integer('count'),
		// TEXT, not NUMERIC: NUMERIC affinity turns '12.50' into 12.5 (see the test below), so a decimal keeps its
		// exact string only as TEXT — Postgres numeric's contract.
		amount: text('amount'),
		amountNumeric: numeric('amount_numeric'),
		done: integer('done', { mode: 'boolean' }).notNull().default(false),
		ownerId: text('owner_id'),
		dueOn: text('due_on'),
		seenAt: text('seen_at'),
		meta: text('meta', { mode: 'json' }),
		tags: text('tags', { mode: 'json' }).$type<string[]>(),
		status: text('status', { enum: ['open', 'closed'] }).notNull(),
		deliveredAt: text('delivered_at'),
		deliveredVia: text('delivered_via'),
		createdAt: text('created_at').notNull().default(ISO_NOW),
	},
	(tCols) => [
		check('notes_title_len', sql`length(${tCols.title}) <= 20`),
		check('notes_status_check', sql`${tCols.status} IN ('open', 'closed')`),
		// A value object's columns: all of it or none of it (PROPOSAL-value-objects, phase 1).
		check('notes_delivered_all_or_none', sql`(${tCols.deliveredAt} IS NULL) = (${tCols.deliveredVia} IS NULL)`),
	],
);

const DDL = `
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  count INTEGER,
  amount TEXT,
  amount_numeric NUMERIC,
  done INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  due_on TEXT,
  seen_at TEXT,
  meta TEXT,
  tags TEXT,
  status TEXT NOT NULL,
  delivered_at TEXT,
  delivered_via TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT notes_title_len CHECK (length(title) <= 20),
  CONSTRAINT notes_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT notes_delivered_all_or_none CHECK ((delivered_at IS NULL) = (delivered_via IS NULL))
);`;

let db: ReturnType<typeof drizzleOver>;
let raw: Database;

beforeEach(() => {
	raw = new Database(':memory:');
	raw.exec(DDL);
	db = drizzleOver(handleOver(raw));
});

describe('sqlite-proxy over a positional handle', () => {
	it('every storage kind round-trips', async () => {
		const [row] = await db
			.insert(notes)
			.values({
				title: 'first',
				count: 3,
				amount: '12.50',
				done: true,
				ownerId: '0d6f…owner',
				dueOn: '2026-11-26',
				seenAt: '2026-11-26T19:30:00.000Z',
				meta: { a: 1, nested: { b: [1, 2] } },
				tags: ['x', 'y'],
				status: 'open',
				deliveredAt: '2026-11-26T19:31:00.000Z',
				deliveredVia: 'pull',
			})
			.returning();
		expect(row).toBeDefined();
		const got = await db.select().from(notes).where(eq(notes.id, row!.id)).get();
		expect(got).toEqual(row);
		expect(got!.done).toBe(true);
		expect(got!.amount).toBe('12.50');
		expect(got!.meta).toEqual({ a: 1, nested: { b: [1, 2] } });
		expect(got!.tags).toEqual(['x', 'y']);
		expect(got!.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(got!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		// Stored as SQLite sees it: 0/1, JSON text.
		expect(raw.query('SELECT done, tags FROM notes').values()).toEqual([[1, '["x","y"]']]);
	});

	it('NULLs come back as null (missing-vs-null is the record layer’s, not storage’s)', async () => {
		await db.insert(notes).values({ title: 'bare', status: 'closed' });
		const got = await db.select().from(notes).get();
		expect(got).toMatchObject({ count: null, amount: null, meta: null, tags: null, deliveredAt: null, done: false });
	});

	it('a decimal keeps its exact string only as TEXT: NUMERIC affinity drops the scale', async () => {
		await db.insert(notes).values({ title: 't', status: 'open', amount: '12.50', amountNumeric: '12.50' });
		const got = await db.select().from(notes).get();
		expect(got!.amount).toBe('12.50');
		expect(got!.amountNumeric).toBe('12.5');
	});

	it('get on no rows is undefined; all on no rows is []', async () => {
		expect(await db.select().from(notes).get()).toBeUndefined();
		expect(await db.select().from(notes).all()).toEqual([]);
	});

	it('a join with repeated column names maps by position, not by name', async () => {
		await db.insert(notes).values([
			{ id: 'a', title: 'parent', status: 'open' },
			{ id: 'b', title: 'child', status: 'open', ownerId: 'a' },
		]);
		const child = await db
			.select({ childTitle: notes.title, ownerTitle: sql<string>`o.title` })
			.from(notes)
			.innerJoin(sql`notes o`, sql`o.id = ${notes.ownerId}`)
			.get();
		expect(child).toEqual({ childTitle: 'child', ownerTitle: 'parent' });
	});

	it('updates go through run, and returning() through values', async () => {
		await db.insert(notes).values({ id: 'n', title: 't', status: 'open' });
		const [moved] = await db.update(notes).set({ status: 'closed' }).where(eq(notes.id, 'n')).returning();
		expect(moved!.status).toBe('closed');
		const none = await db.update(notes).set({ status: 'closed' }).where(eq(notes.id, 'missing')).returning();
		expect(none).toEqual([]);
	});
});

describe('the CHECKs the renderer will emit refuse bad rows', () => {
	it('an enum value outside the choices', async () => {
		expect(await sqliteError(db.insert(notes).values({ title: 't', status: 'archived' as 'open' }))).toMatch(/CHECK constraint failed/);
	});

	it('a string longer than max_length (SQLite ignores the length hint; the CHECK does not)', async () => {
		expect(await sqliteError(db.insert(notes).values({ title: 'x'.repeat(21), status: 'open' }))).toMatch(/CHECK constraint failed/);
	});

	it('a half-set value object (all-or-none)', async () => {
		expect(await sqliteError(db.insert(notes).values({ title: 't', status: 'open', deliveredAt: '2026-11-26T00:00:00.000Z' }))).toMatch(/CHECK constraint failed/);
	});
});
