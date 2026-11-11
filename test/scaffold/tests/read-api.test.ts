/**
 * READ-1 (docs/specs/READ-1.md §8.3) — the generated read surface, against
 * real Postgres, through GENERATED repositories.
 *
 * The graph is REL-2's scoped leak graph (`region` / `site` / `sensor`, every
 * entity tenant-scoped + soft-delete + user-tracking). Every test plants poison
 * rows — another tenant's, a soft-deleted one, another user's — at the root AND
 * at the hop, and asserts rows, never emitted text.
 *
 *   R1  `list({ where, with })` executes (#840 — failed with "invalid reference
 *       to FROM-clause entry" before READ-1) and returns the right rows;
 *   R2  `findByIds` — input order, duplicates once, `[]`, absent ids, a mask
 *       without `id`, mask + include in one statement;
 *   R3  root AND hop scope on every method, with and without options;
 *   R4  `scopedRoot(SCOPES.<t>)` on a hand-written `db.query` excludes the same
 *       root poison a repository does (#843);
 *   R5  `withRequester` returning an un-awaited `db.query` builds inside the
 *       context under `strict` (#842).
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { like } from 'drizzle-orm';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

import type {
	getTestDb as GetTestDb,
	truncateAll as TruncateAll,
	closeDb as CloseDb,
} from './setup';
import type { regions as Regions, sites as Sites } from '../schema';

let getTestDb: typeof GetTestDb;
let truncateAll: typeof TruncateAll;
let closeDb: typeof CloseDb;
let regions: typeof Regions;
let sites: typeof Sites;
let withRequester: typeof import('@shared/base-classes/tenant-context').withRequester;
let scopedRoot: typeof import('@shared/base-classes/scope-filters').scopedRoot;
// GENERATED code — imported dynamically from `@gen/…`, so untyped here for the
// reason `relation-scope.test.ts` gives. Their types are asserted by the
// smoke's `tsc` over a consumer project (READ-1 §8.1).
let RegionRepository: any;
let SiteRepository: any;
let SCOPES: any;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_OTHER = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	({ getTestDb, truncateAll, closeDb } = await import('./setup'));
	({ regions, sites } = await import('../schema'));
	({ withRequester } = await import('@shared/base-classes/tenant-context'));
	({ scopedRoot } = await import('@shared/base-classes/scope-filters'));
	({ RegionRepository } = await import('@gen/modules/regions/region.repository'));
	({ SiteRepository } = await import('@gen/modules/sites/site.repository'));
	({ SCOPES } = await import('@gen/generated/relations'));
});

beforeEach(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await truncateAll();
});

afterAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await closeDb();
});

function asA<T>(fn: () => PromiseLike<T> | T): Promise<T> {
	return withRequester({ userId: USER_A, organizationId: null, tenantId: TENANT_A }, fn);
}

interface Seeded {
	/** Tenant A's readable regions, in insertion order. */
	readable: string[];
	/** Poison regions: tenant B's, soft-deleted, another user's. */
	poison: string[];
	/** Tenant A's readable site under readable[0]. */
	siteId: string;
}

/**
 * Three readable tenant-A regions (r1, r2, r3) and three poison ones. Under r1,
 * one readable site and three poison sites. Raw inserts: the point is that the
 * READ refuses the poison, not that a write path refuses to create it.
 */
async function seed(): Promise<Seeded> {
	const db = getTestDb();
	const mine = { tenantId: TENANT_A, userId: USER_A };
	const readable = await db
		.insert(regions)
		.values([
			{ name: 'a-r1', ...mine },
			{ name: 'a-r2', ...mine },
			{ name: 'a-r3', ...mine },
		])
		.returning();
	const poison = await db
		.insert(regions)
		.values([
			{ name: 'a-leak-tenant', tenantId: TENANT_B, userId: USER_A },
			{ name: 'a-leak-deleted', ...mine, deletedAt: new Date() },
			{ name: 'a-leak-user', tenantId: TENANT_A, userId: USER_OTHER },
		])
		.returning();
	const r1 = readable[0]!.id;
	const [site] = await db.insert(sites).values({ name: 'Site', regionId: r1, ...mine }).returning();
	await db.insert(sites).values([
		{ name: 'Site', regionId: r1, tenantId: TENANT_B, userId: USER_A },
		{ name: 'Site', regionId: r1, ...mine, deletedAt: new Date() },
		{ name: 'Site', regionId: r1, tenantId: TENANT_A, userId: USER_OTHER },
	]);
	return { readable: readable.map((r) => r.id), poison: poison.map((r) => r.id), siteId: site!.id };
}

d('READ-1 — the generated read surface against Postgres', () => {
	// ── R1 · the caller's `where` on the include path (#840) ───────────────────
	test('R1 — list({ where, with }) executes on a scoped entity and returns the right rows', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());
		await asA(async () => {
			const rows = await repo.list({
				where: (t: typeof regions) => like(t.name, 'a-%'),
				with: { sites: true },
				sort: [{ column: 'name', direction: 'asc' }],
			});
			// Every poison root also matches `a-%` — the scope, not the filter, drops them.
			expect(rows.map((r: { name: string }) => r.name)).toEqual(['a-r1', 'a-r2', 'a-r3']);
			const r1 = rows.find((r: { id: string }) => r.id === ids.readable[0]);
			expect(r1.sites.map((s: { id: string }) => s.id)).toEqual([ids.siteId]);
		});
	});

	// ── R2 · findByIds semantics (#841) ─────────────────────────────────────
	test('R2a — rows in INPUT order, duplicates once, out-of-scope ids absent', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());
		const [r1, r2, r3] = ids.readable as [string, string, string];
		await asA(async () => {
			const rows = await repo.findByIds([r3, ...ids.poison, r1, r3, r2]);
			expect(rows.map((r: { id: string }) => r.id)).toEqual([r3, r1, r2]);
		});
	});

	test('R2b — `[]` returns [] (and needs no context: no statement is built)', async () => {
		const repo = new RegionRepository(getTestDb());
		expect(await repo.findByIds([])).toEqual([]);
	});

	test('R2c — a mask without `id` still orders, and the rows carry only the mask', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());
		const [r1, , r3] = ids.readable as [string, string, string];
		await asA(async () => {
			const rows = await repo.findByIds([r3, r1], { columns: { name: true } });
			expect(rows).toEqual([{ name: 'a-r3' }, { name: 'a-r1' }]);
		});
	});

	test('R2d — mask + include with its own mask, one statement, hop scoped', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());
		await asA(async () => {
			const rows = await repo.findByIds(ids.readable, {
				columns: { id: true, name: true },
				with: { sites: { columns: { id: true } } },
			});
			expect(rows).toHaveLength(3);
			expect(Object.keys(rows[0]).sort()).toEqual(['id', 'name', 'sites']);
			expect(rows[0].sites).toEqual([{ id: ids.siteId }]);
			expect(rows[1].sites).toEqual([]);
		});
	});

	// ── R3 · root and hop scope on every method ─────────────────────────────
	test('R3a — findById: a poison root is null with and without options', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());
		await asA(async () => {
			for (const id of ids.poison) {
				expect(await repo.findById(id)).toBeNull();
				expect(await repo.findById(id, { columns: { name: true } })).toBeNull();
				expect(await repo.findById(id, { with: { sites: true } })).toBeNull();
			}
			const r1 = await repo.findById(ids.readable[0], { columns: { name: true }, with: { sites: true } });
			expect(r1).toEqual({ name: 'a-r1', sites: [expect.objectContaining({ id: ids.siteId })] });
		});
	});

	test('R3b — list: no poison root, with or without options', async () => {
		await seed();
		const repo = new RegionRepository(getTestDb());
		await asA(async () => {
			const plain = await repo.list();
			const masked = await repo.list({ columns: { name: true } });
			const included = await repo.list({ with: { sites: true } });
			for (const rows of [plain, masked, included]) {
				expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(['a-r1', 'a-r2', 'a-r3']);
			}
			expect(await repo.count()).toBe(3);
			expect(await repo.count((t: typeof regions) => like(t.name, 'a-r%'))).toBe(3);
		});
	});

	test('R3c — a declarative finder and an FK finder: poison excluded at the root and the hop', async () => {
		const ids = await seed();
		const repo = new SiteRepository(getTestDb());
		await asA(async () => {
			// Four rows named 'Site' exist under r1; one is readable.
			const byName = await repo.findByName('Site', { with: { region: { columns: { name: true } } } });
			expect(byName.map((s: { id: string }) => s.id)).toEqual([ids.siteId]);
			expect(byName[0].region).toEqual({ name: 'a-r1' });

			const byRegion = await repo.findByRegionId(ids.readable[0], { columns: { id: true } });
			expect(byRegion).toEqual([{ id: ids.siteId }]);
		});
	});

	// ── R4 · the exported root scope (#843) ─────────────────────────────────
	test('R4 — scopedRoot(SCOPES.regions) on a hand-written db.query excludes the root poison', async () => {
		const ids = await seed();
		const db = getTestDb();
		const all = [...ids.readable, ...ids.poison];
		await asA(async () => {
			const unscopedRoot = await db.query.regions.findMany({ where: { id: { in: all } } });
			// The gap this closes: hops are scoped by the manifest, the ROOT is not.
			expect(unscopedRoot).toHaveLength(6);

			const scoped = await db.query.regions.findMany({
				where: { AND: [{ id: { in: all } }, scopedRoot(SCOPES.regions, 'read-api.test')] },
			});
			expect(scoped.map((r) => r.id).sort()).toEqual([...ids.readable].sort());
		});
	});

	// ── R5 · withRequester and a lazy thenable (#842) ───────────────────────
	test('R5 — an un-awaited db.query traversal returned from withRequester runs inside the context', async () => {
		const ids = await seed();
		const db = getTestDb();
		// No `async`/`await` in the callback: the builder is returned as-is. Under
		// `strict` the hop used to throw `No requester context active`, because the
		// statement was built after `withRequester` had returned.
		const rows = await asA(() =>
			db.query.regions.findMany({ where: { id: { eq: ids.readable[0] } }, with: { sites: true } }),
		);
		expect(rows[0]!.sites.map((s) => s.id)).toEqual([ids.siteId]);
	});
});
