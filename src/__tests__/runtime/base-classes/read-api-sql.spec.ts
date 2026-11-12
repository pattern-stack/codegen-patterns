/**
 * READ-1 (docs/specs/READ-1.md §8.2) — the generated read surface, as SQL.
 *
 * `WidgetRepository` below is written in EXACTLY the shape
 * `templates/entity/new/backend/repository.ejs.t` emits (READ-1 §2.3): every
 * read on RQBv2, its root predicate one `{ RAW: this.rootFilter(…) }`. The
 * GENERATED repository is driven against Postgres by
 * `test/scaffold/tests/read-api.test.ts` (`just test-integration`); this file
 * pins the SQL each method renders, without Docker, through a fake `pg` client
 * that records every statement and serves canned rows.
 *
 * What each test guards:
 *   - the root predicate renders on the ALIAS (`"d0"."…"`), never on the real
 *     table name — on every method, with and without options (#840);
 *   - a caller's `where` is a function of the alias too;
 *   - the root `select` names exactly the mask (+ `id` for `findByIds`, stripped);
 *   - every hop carries `hopScope`;
 *   - `findByIds`' contract: no statement for `[]`, de-duplication, input order.
 */
import { describe, expect, it } from 'bun:test';
import { defineRelations, eq, inArray, like } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { BuildQueryResult, DBQueryConfig } from 'drizzle-orm';

import {
	BaseRepository,
	column,
	hasColumn,
	type BehaviorConfig,
	type ListOptions,
	type ReadOptions,
} from '../../../../runtime/base-classes/base-repository';
import {
	hopScope,
	scopedRoot,
	tableScope,
	UNSCOPED,
} from '../../../../runtime/base-classes/scope-filters';
import { withRequester } from '../../../../runtime/base-classes/tenant-context';
import { BaseService } from '../../../../runtime/base-classes/base-service';

// ── the schema, as the entity templates emit one ───────────────────────────
const owners = pgTable('owners', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	deletedAt: timestamp('deleted_at'),
	name: text('name').notNull(),
});

const widgets = pgTable('widgets', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	deletedAt: timestamp('deleted_at'),
	ownerId: uuid('owner_id').notNull(),
	name: text('name').notNull(),
	sku: text('sku'),
});

const schema = { owners, widgets };

// ── the manifest, as `emit-manifest.ts` renders it ──────────────────────────
const OWNERS_SCOPE = tableScope(owners, {
	tenantScoped: true,
	tenantColumn: 'tenantId',
	softDelete: true,
	userTracking: false,
	enforcement: 'strict',
});
const WIDGETS_SCOPE = tableScope(widgets, {
	tenantScoped: true,
	tenantColumn: 'tenantId',
	softDelete: true,
	userTracking: false,
	enforcement: 'strict',
});

const relations = defineRelations(schema, (r) => ({
	owners: {
		widgets: r.many.widgets({
			from: r.owners.id,
			to: r.widgets.ownerId,
			where: { RAW: (t) => hopScope(t, WIDGETS_SCOPE, 'owners.widgets') },
		}),
	},
	widgets: {
		owner: r.one.owners({
			from: r.widgets.ownerId,
			to: r.owners.id,
			optional: false,
			where: { RAW: (t) => hopScope(t, OWNERS_SCOPE, 'widgets.owner') },
		}),
	},
}));
type Relations = typeof relations;
// The manifest's own conditional form (REL-2 §2.3) — a bare indexed access is TS2536.
type IncludeOf<T extends keyof Relations> =
	'with' extends keyof DBQueryConfig<'one', Relations, Relations[T]>
		? NonNullable<DBQueryConfig<'one', Relations, Relations[T]>['with']>
		: Record<string, never>;
type ColumnsOf<T extends keyof Relations> = NonNullable<
	DBQueryConfig<'many', Relations, Relations[T]>['columns']
>;
type ResultOf<
	T extends keyof Relations,
	W extends IncludeOf<T>,
	C extends ColumnsOf<T> | undefined = undefined,
> = BuildQueryResult<Relations, Relations[T], { columns: C; with: W }>;

// ── a fake pg client: records statements, serves canned rows ────────────────
interface Recorded {
	text: string;
	values: unknown[];
}
function fakeDb(rows: unknown[][] = []) {
	const statements: Recorded[] = [];
	const client = {
		query: async (cfg: { text: string }, values?: unknown[]) => {
			statements.push({ text: cfg.text, values: values ?? [] });
			return { rows, fields: [] };
		},
	};
	// The fake is structurally a `pg` client for every method drizzle calls.
	const db = drizzle({ client: client as never, relations });
	return { db, statements };
}

// ── the repository, in the generated shape ──────────────────────────────────
type Widget = InferSelectModel<typeof widgets>;
type WidgetColumns = ColumnsOf<'widgets'>;
type WidgetInclude = IncludeOf<'widgets'>;
type WidgetNoInclude = Record<string, never>;
type WidgetResult<
	W extends WidgetInclude = WidgetNoInclude,
	C extends WidgetColumns | undefined = undefined,
> = ResultOf<'widgets', W, C>;

class WidgetRepository extends BaseRepository<Widget, typeof widgets, Relations> {
	readonly table = widgets;
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: true,
		userTracking: false,
		tenantScoped: true,
		tenantColumn: 'tenantId',
	};
	protected override readonly scopeEnforcement = 'strict' as const;

	constructor(db: ConstructorParameters<typeof BaseRepository<Widget, typeof widgets, Relations>>[0]) {
		super(db);
		this.requireRelationalQuery('widgets');
		this.claimGeneratedReads(WidgetRepository);
	}

	/** Exposed for the review-#1 guard test. */
	order<T extends object>(rows: T[], ids: string[]): T[] {
		return this.inInputOrder(rows, ids, false);
	}

	/** Exposed for the review-#7 test. */
	activeOwner() {
		return this.activeParentFilter(owners, 'ownerId');
	}

	// A unique `queries:` finder, in the generated shape.
	async findBySku<W extends WidgetInclude = WidgetNoInclude, C extends WidgetColumns | undefined = undefined>(
		sku: string,
		opts?: ReadOptions<W, C>,
	): Promise<WidgetResult<W, C> | null> {
		const row = await this.db.query.widgets.findFirst({
			where: { RAW: this.rootFilter((t) => eq(t.sku, sku)) },
			columns: this.checkColumns<C>(opts?.columns),
			with: opts?.with,
		});
		return (row as WidgetResult<W, C> | undefined) ?? null;
	}

	override async findById<W extends WidgetInclude = WidgetNoInclude, C extends WidgetColumns | undefined = undefined>(
		id: string,
		opts?: ReadOptions<W, C>,
	): Promise<WidgetResult<W, C> | null> {
		const row = await this.db.query.widgets.findFirst({
			where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
			columns: this.checkColumns<C>(opts?.columns),
			with: opts?.with,
		});
		return (row as WidgetResult<W, C> | undefined) ?? null;
	}

	override async findByIds<W extends WidgetInclude = WidgetNoInclude, C extends WidgetColumns | undefined = undefined>(
		ids: readonly string[],
		opts?: ReadOptions<W, C>,
	): Promise<Array<WidgetResult<W, C>>> {
		const unique = this.uniqueIds(ids);
		if (unique.length === 0) {
			this.assertReadScope();
			return [];
		}
		const mask = this.byIdsColumns(this.checkColumns<C>(opts?.columns));
		const rows = await this.db.query.widgets.findMany({
			where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },
			columns: mask.columns,
			with: opts?.with,
		});
		return this.inInputOrder(rows, unique, mask.stripId) as Array<WidgetResult<W, C>>;
	}

	override async list<W extends WidgetInclude = WidgetNoInclude, C extends WidgetColumns | undefined = undefined>(
		query?: ListOptions<typeof widgets> & ReadOptions<W, C>,
	): Promise<Array<WidgetResult<W, C>>> {
		const sort = query?.sort;
		const rows = await this.db.query.widgets.findMany({
			where: { RAW: this.rootFilter(query?.where) },
			columns: this.checkColumns<C>(query?.columns),
			with: query?.with,
			orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
			limit: query?.limit,
			offset: query?.offset,
		});
		return rows as Array<WidgetResult<W, C>>;
	}

	async findByOwnerId<W extends WidgetInclude = WidgetNoInclude, C extends WidgetColumns | undefined = undefined>(
		id: string,
		opts?: { limit?: number } & ReadOptions<W, C>,
	): Promise<Array<WidgetResult<W, C>>> {
		const rows = await this.db.query.widgets.findMany({
			where: { RAW: this.rootFilter((t) => eq(t.ownerId, id)) },
			columns: this.checkColumns<C>(opts?.columns),
			with: opts?.with,
			orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },
			limit: opts?.limit,
		});
		return rows as Array<WidgetResult<W, C>>;
	}
}

const T1 = '11111111-1111-4111-8111-111111111111';
const asT1 = <T>(fn: () => PromiseLike<T> | T) =>
	withRequester({ userId: 'u1', organizationId: null, tenantId: T1 }, fn);

/** Every way a generated read can be called, against one repository. */
const CALLS: Array<[string, (r: WidgetRepository) => Promise<unknown>]> = [
	['findById', (r) => r.findById('w1')],
	['findById + columns', (r) => r.findById('w1', { columns: { name: true } })],
	['findById + with', (r) => r.findById('w1', { with: { owner: true } })],
	['findByIds', (r) => r.findByIds(['w1', 'w2'])],
	['findByIds + columns + with', (r) => r.findByIds(['w1'], { columns: { name: true }, with: { owner: { columns: { name: true } } } })],
	['list', (r) => r.list()],
	['list + where + with', (r) => r.list({ where: (t) => like(t.name, 'a%'), with: { owner: true } })],
	['list + sort + limit + columns', (r) => r.list({ sort: [{ column: 'name', direction: 'asc' }], limit: 5, columns: { name: true } })],
	['findBySku (queries: unique)', (r) => r.findBySku('s1', { columns: { name: true }, with: { owner: true } })],
	['findByOwnerId', (r) => r.findByOwnerId('o1')],
	['findByOwnerId + with', (r) => r.findByOwnerId('o1', { with: { owner: true }, limit: 3 })],
];

describe('READ-1 §3 — every generated read renders its root on the alias, scoped', () => {
	for (const [name, call] of CALLS) {
		it(name, async () => {
			const { db, statements } = fakeDb();
			await asT1(() => call(new WidgetRepository(db)));
			expect(statements).toHaveLength(1);
			const sql = statements[0]!.text;
			// The root is aliased, and its scope renders on the alias.
			expect(sql).toContain('from "widgets" as "d0"');
			expect(sql).toContain('"d0"."deleted_at" is null');
			expect(sql).toContain('"d0"."tenant_id" = $');
			// Nothing on the statement names the real root table as a qualifier.
			expect(sql).not.toContain('"widgets".');
			expect(statements[0]!.values).toContain(T1);
		});
	}

	it('a caller `where` renders on the alias, ANDed with the scope', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).list({ where: (t) => like(t.name, 'a%'), with: { owner: true } }));
		expect(statements[0]!.text).toMatch(/"d0"\."name" like \$\d/);
	});

	it('every hop carries hopScope — the include and the root agree', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).findById('w1', { with: { owner: true } }));
		const sql = statements[0]!.text;
		expect(sql).toContain('"d1"."deleted_at" is null');
		expect(sql).toContain('"d1"."tenant_id" = $');
	});

	it('the root `select` names exactly the mask', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).findById('w1', { columns: { name: true, sku: true } }));
		const select = statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '));
		expect(select).toBe('select "d0"."name" as "name", "d0"."sku" as "sku"');
	});

	it('strict, no ambient context: throws before any statement is sent', async () => {
		const { db, statements } = fakeDb();
		await expect(new WidgetRepository(db).findById('w1')).rejects.toThrow(/requester context/i);
		expect(statements).toHaveLength(0);
	});

	it('a mask whose only keys are `undefined` is empty too — it throws, never selects nothing', async () => {
		const { db, statements } = fakeDb();
		await expect(
			asT1(() => new WidgetRepository(db).findById('w1', { columns: { name: undefined }, with: { owner: true } })),
		).rejects.toThrow(/WidgetRepository: an empty `columns` mask/);
		expect(statements).toHaveLength(0);
	});

	it('`undefined`-valued keys are dropped from a mask that names a column', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).findById('w1', { columns: { name: true, sku: undefined } }));
		expect(statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '))).toBe('select "d0"."name" as "name"');
	});

	it('an FK finder with a `limit` orders by id — a stable subset', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).findByOwnerId('o1', { limit: 3 }));
		expect(statements[0]!.text).toContain('order by "d0"."id" asc');
	});

	it('an empty mask throws, naming the repository', async () => {
		const { db, statements } = fakeDb();
		const runtimeMask: Record<string, true> = {};
		await expect(
			asT1(() => new WidgetRepository(db).findById('w1', { columns: runtimeMask })),
		).rejects.toThrow(/WidgetRepository: an empty `columns` mask/);
		expect(statements).toHaveLength(0);
	});
});

describe('READ-1 §2.4 — findByIds', () => {
	it('`[]` issues no statement', async () => {
		const { db, statements } = fakeDb();
		expect(await asT1(() => new WidgetRepository(db).findByIds([]))).toEqual([]);
		expect(statements).toHaveLength(0);
	});

	it('`[]` under strict with no ambient context throws, as a non-empty read would', async () => {
		const { db, statements } = fakeDb();
		await expect(new WidgetRepository(db).findByIds([])).rejects.toThrow(/requester context/i);
		expect(statements).toHaveLength(0);
	});

	it('duplicates are bound once; rows come back in INPUT order; a missing id is absent', async () => {
		// Postgres returns them in its own order — w3, w1 — and w2 does not exist.
		const { db, statements } = fakeDb([
			['w3', 'Three'],
			['w1', 'One'],
		]);
		const rows = await asT1(() =>
			new WidgetRepository(db).findByIds(['w1', 'w2', 'w1', 'w3'], { columns: { id: true, name: true } }),
		);
		expect(rows).toEqual([
			{ id: 'w1', name: 'One' },
			{ id: 'w3', name: 'Three' },
		]);
		const idParams = statements[0]!.values.filter((v) => typeof v === 'string' && v.startsWith('w'));
		expect(idParams).toEqual(['w1', 'w2', 'w3']);
	});

	it('a mask that omits `id` still orders — `id` is selected, then stripped', async () => {
		const { db, statements } = fakeDb([
			['B', 'w2'],
			['A', 'w1'],
		]);
		const rows = await asT1(() =>
			new WidgetRepository(db).findByIds(['w1', 'w2'], { columns: { name: true } }),
		);
		expect(statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '))).toBe(
			'select "d0"."name" as "name", "d0"."id" as "id"',
		);
		expect(rows).toEqual([{ name: 'A' }, { name: 'B' }]);
	});

	it('an EXCLUSION mask that excludes `id` keeps its other exclusions and still orders', async () => {
		const { db, statements } = fakeDb();
		await asT1(() =>
			new WidgetRepository(db).findByIds(['w1'], { columns: { id: false, sku: false } }),
		);
		const select = statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '));
		expect(select).toContain('"d0"."id"');
		expect(select).not.toContain('"d0"."sku"');
		expect(select).toContain('"d0"."name"');
	});
});

describe('READ-1 review — findByIds edge cases', () => {
	const UPPER = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';
	const LOWER = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

	it('#1 `{ id: false }` alone: no empty mask is sent, rows come back, `id` stripped', async () => {
		const { db, statements } = fakeDb([[LOWER, 'T1', null, 'o1', 'One', null]]);
		const rows = await asT1(() => new WidgetRepository(db).findByIds([LOWER], { columns: { id: false } }));
		expect(statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '))).toContain('"d0"."id"');
		expect(rows).toEqual([{ tenantId: 'T1', deletedAt: null, ownerId: 'o1', name: 'One', sku: null }]);
	});

	it('#1 `{ id: false }` with a `with`: still selects the root (and `id`), never relations only', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new WidgetRepository(db).findByIds([LOWER], { columns: { id: false }, with: { owner: true } }));
		const select = statements[0]!.text.slice(0, statements[0]!.text.indexOf(' from '));
		expect(select).toContain('"d0"."id"');
		expect(select).toContain('"d0"."name"');
	});

	it('#1 a row without `id` THROWS instead of being dropped', () => {
		const repo = new WidgetRepository(fakeDb().db);
		expect(() => repo.order([{ name: 'x' }], ['w1'])).toThrow(/a row came back without an `id`/);
	});

	it('a row no input id claims THROWS — a spelling idKey missed is loud, not lossy', () => {
		const repo = new WidgetRepository(fakeDb().db);
		expect(() => repo.order([{ id: 'w9' }], ['w1'])).toThrow(/no input id\s+claims them/);
	});

	it('#2 an uppercase / braced / unhyphenated uuid finds its row and is read once', async () => {
		const { db, statements } = fakeDb([[LOWER, 'One']]);
		const rows = await asT1(() =>
			new WidgetRepository(db).findByIds(
				[UPPER, `{${LOWER}}`, LOWER.replace(/-/g, '')],
				{ columns: { id: true, name: true } },
			),
		);
		expect(rows).toEqual([{ id: LOWER, name: 'One' }]);
		const bound = statements[0]!.values.filter((v) => typeof v === 'string' && /a0ee/i.test(v));
		expect(bound).toEqual([UPPER]);
	});
});

describe('READ-1 review R-2 — a non-uuid key is compared as text', () => {
	const counters = pgTable('counters', { id: integer('id').primaryKey(), label: text('label') });
	class CounterRepository extends BaseRepository<InferSelectModel<typeof counters>, typeof counters, Relations> {
		readonly table = counters;
	}

	it("findByIds(['7']) finds the row the driver returns as 7, in input order", async () => {
		// Postgres coerced the '7' bind and matched; node-postgres hands back a number.
		const { db } = fakeDb([
			[9, 'nine'],
			[7, 'seven'],
		]);
		const rows = await new CounterRepository(db).findByIds(['7', '9', '7']);
		expect(rows).toEqual([
			{ id: 7, label: 'seven' },
			{ id: 9, label: 'nine' },
		]);
	});

	it("an integer key is compared as an integer — '07' is the row 7, read once with '7'", async () => {
		// Postgres parses '07' to 7, so both binds match the one row.
		const { db, statements } = fakeDb([[7, 'seven']]);
		expect(await new CounterRepository(db).findByIds(['07'])).toEqual([{ id: 7, label: 'seven' }]);
		await new CounterRepository(db).findByIds(['07', '7']);
		expect(statements[1]!.values).toEqual(['07']);
	});
});

describe('READ-1 review — a caller-supplied column key is an OWN key', () => {
	it('`toString` is not a column (it was `Object.prototype.toString`, rendered as `$1`)', () => {
		expect(hasColumn(widgets, 'name')).toBe(true);
		expect(hasColumn(widgets, 'toString')).toBe(false);
		expect(hasColumn(widgets, 'constructor')).toBe(false);
		expect(() => column(widgets, 'toString', 'WidgetRepository')).toThrow(
			"WidgetRepository: table has no column 'toString'",
		);
	});

	it('a sort on a prototype name throws instead of being silently ignored', async () => {
		const { db, statements } = fakeDb();
		await expect(
			asT1(() => new WidgetRepository(db).list({ sort: [{ column: 'toString', direction: 'asc' }] })),
		).rejects.toThrow("table has no column 'toString'");
		expect(statements).toHaveLength(0);
	});
});

describe('READ-1 review #7 — activeParentFilter renders on the handle it is given', () => {
	it('correlates the EXISTS on the alias, never the real root name', async () => {
		const { db, statements } = fakeDb();
		const repo = new WidgetRepository(db);
		await asT1(() => repo.list({ where: repo.activeOwner() }));
		expect(statements[0]!.text).toContain('p.id = "d0"."owner_id"');
		expect(statements[0]!.text).not.toContain('"widgets".');
	});
});

describe('READ-1 review #8a — a client without the relations manifest fails at construction', () => {
	it('names the cause', () => {
		const bare = drizzle({ client: { query: async () => ({ rows: [] }) } as never });
		expect(() => new WidgetRepository(bare as never)).toThrow(
			/no relational query for 'widgets'.*drizzle\(\{ client, relations \}\)/,
		);
	});
});

// ── READ-1 §3.4: a base or mixin override of a generated read is LOUD ────────
type WidgetDb = ConstructorParameters<typeof BaseRepository<Widget, typeof widgets, Relations>>[0];

/** A project's own pattern base class that overrides `findById`. */
abstract class AuditedWidgetBase extends BaseRepository<Widget, typeof widgets, Relations> {
	readonly audited: string[] = [];
	override async findById(id: string): Promise<Widget | null> {
		this.audited.push(id);
		return super.findById(id);
	}
}

/** A capability mixin (ADR-041 shape) that overrides `list`, and one that overrides only `count`. */
type RepoCtor = abstract new (...args: any[]) => BaseRepository<Widget, typeof widgets, Relations>;
function WithCachedList<TBase extends RepoCtor>(Base: TBase) {
	abstract class CachedList extends Base {
		override async list(): Promise<Widget[]> {
			return [];
		}
	}
	return CachedList;
}
function WithCountedReads<TBase extends RepoCtor>(Base: TBase) {
	abstract class CountedReads extends Base {
		counted = 0;
		override async count(where?: Parameters<BaseRepository<Widget, typeof widgets, Relations>['count']>[0]) {
			this.counted++;
			return super.count(where);
		}
	}
	return CountedReads;
}

/** The generated shape over each: it defines `findById` / `list` itself and claims them. */
class OverAuditedBase extends AuditedWidgetBase {
	readonly table = widgets;
	constructor(db: WidgetDb) {
		super(db);
		this.claimGeneratedReads(OverAuditedBase);
	}
	override async findById(id: string): Promise<Widget | null> {
		return (await this.db.query.widgets.findFirst({ where: { RAW: this.rootFilter((t) => eq(t.id, id)) } })) ?? null;
	}
}
class OverCachedList extends WithCachedList(BaseRepository<Widget, typeof widgets, Relations>) {
	readonly table = widgets;
	constructor(db: WidgetDb) {
		super(db);
		this.claimGeneratedReads(OverCachedList);
	}
	override async list(): Promise<Widget[]> {
		return this.db.query.widgets.findMany({ where: { RAW: this.rootFilter() } });
	}
}
class OverCountedReads extends WithCountedReads(BaseRepository<Widget, typeof widgets, Relations>) {
	readonly table = widgets;
	constructor(db: WidgetDb) {
		super(db);
		this.claimGeneratedReads(OverCountedReads);
	}
}
/** A project SUBCLASS of the generated class — its override runs, so it is not refused. */
class CustomWidgetRepository extends WidgetRepository {
	override async findById(id: string): Promise<Widget | null> {
		return id === 'custom' ? null : super.findById(id);
	}
}

/** The same rule on the service: a pattern's service base overriding `findById`. */
abstract class CachedServiceBase extends BaseService<WidgetRepository, Widget> {
	override findById(id: string): Promise<Widget | null> {
		return this.repository.findById(id);
	}
}
class OverCachedService extends CachedServiceBase {
	constructor(repository: WidgetRepository) {
		super(repository);
		this.claimGeneratedReads(OverCachedService);
	}
}
class PlainWidgetService extends BaseService<WidgetRepository, Widget> {
	constructor(repository: WidgetRepository) {
		super(repository);
		this.claimGeneratedReads(PlainWidgetService);
	}
}

describe('READ-1 §3.4 — a base-class or mixin override of a generated read is refused at construction', () => {
	it('a pattern base class overriding `findById`: construction throws, naming the method and the class', () => {
		const { db } = fakeDb();
		expect(() => new OverAuditedBase(db)).toThrow(
			/OverAuditedBase: AuditedWidgetBase\.findById overrides a read the generated OverAuditedBase defines itself, so it would never run/,
		);
	});

	it('a capability mixin overriding `list`: construction throws, naming the mixin', () => {
		const { db } = fakeDb();
		expect(() => new OverCachedList(db)).toThrow(/CachedList\.list overrides a read/);
	});

	it('a mixin overriding only `count` is fine — the generated `count` calls `super`, so it runs', async () => {
		const { db } = fakeDb([[3]]);
		const repo = new OverCountedReads(db);
		await withRequester({ userId: 'u1', organizationId: null, tenantId: '11111111-1111-4111-8111-111111111111' }, () =>
			repo.count(),
		);
		expect(repo.counted).toBe(1);
	});

	it('the generated shape over the plain base constructs; a SUBCLASS of it may override (its override runs)', async () => {
		const { db, statements } = fakeDb();
		expect(() => new WidgetRepository(db)).not.toThrow();
		const custom = new CustomWidgetRepository(db);
		expect(await custom.findById('custom')).toBeNull();
		expect(statements).toHaveLength(0);
	});

	it('the service: a service base overriding `findById` throws; the plain base constructs', () => {
		const repo = new WidgetRepository(fakeDb().db);
		expect(() => new OverCachedService(repo)).toThrow(
			/OverCachedService: CachedServiceBase\.findById overrides a read the generated OverCachedService defines itself/,
		);
		expect(() => new PlainWidgetService(repo)).not.toThrow();
	});
});

describe('READ-1 §5 — scopedRoot: the root of a hand-written db.query', () => {
	it('renders the same scope a repository renders, on the alias', async () => {
		const { db, statements } = fakeDb();
		await asT1(() =>
			db.query.widgets.findMany({
				where: { AND: [{ id: { in: ['w1'] } }, scopedRoot(WIDGETS_SCOPE, 'WidgetLoader')] },
			}),
		);
		const loader = statements[0]!.text;
		const repo = fakeDb();
		await asT1(() => new WidgetRepository(repo.db).findByIds(['w1']));
		for (const sql of [loader, repo.statements[0]!.text]) {
			expect(sql).toContain('"d0"."deleted_at" is null');
			expect(sql).toContain('"d0"."tenant_id" = $');
		}
	});

	it('UNSCOPED renders no predicate', async () => {
		const { db, statements } = fakeDb();
		await db.query.owners.findMany({ where: scopedRoot(tableScope(owners, UNSCOPED), 'x') });
		expect(statements[0]!.text).toContain('where true');
	});

	it('takes only a scope BOUND to its table — another table\'s is a compile error', () => {
		const { db } = fakeDb();
		// @ts-expect-error — a bare ScopeConfig names no table
		void db.query.owners.findMany({ where: scopedRoot(UNSCOPED, 'x') });
		// @ts-expect-error — the widgets scope on the owners query
		void db.query.owners.findMany({ where: scopedRoot(WIDGETS_SCOPE, 'x') });
	});
});

describe('READ-1 §6 — withRequester awaits a lazy thenable INSIDE the context', () => {
	it('a thenable whose `.then` reads the context sees it', async () => {
		const { tryGetRequester } = await import('../../../../runtime/base-classes/tenant-context');
		// Reads the context only when `.then` is called — the shape of a Drizzle builder.
		const lazy: PromiseLike<string | undefined> = {
			then(onfulfilled) {
				const seen = tryGetRequester()?.tenantId ?? undefined;
				return Promise.resolve(onfulfilled ? onfulfilled(seen) : seen) as never;
			},
		};
		expect(await asT1(() => lazy)).toBe(T1);
	});

	it('a Drizzle query returned UN-awaited still builds inside the context (strict hop)', async () => {
		const { db, statements } = fakeDb();
		// Returning the builder, not awaiting it: the hop's `hopScope` reads the
		// ALS when the statement is BUILT, which used to be after the context
		// had exited — `No requester context active`.
		await asT1(() => db.query.widgets.findMany({ with: { owner: true } }));
		expect(statements[0]!.text).toContain('"d1"."tenant_id" = $');
	});
});
