/**
 * REL-2 (#587) — the leak tests. Epic #580 exit criteria, charter I3.
 *
 * Every hop of an include tree is scoped. Not "can be scoped" — *cannot be
 * reached unscoped*. These assert ROWS against real Postgres, at depth 3, with a
 * poison row planted at every level: another tenant's, another user's, and a
 * soft-deleted one.
 *
 * The graph under test is the SCOPED one the emitter generated from
 * `test/scaffold/entities/{region,site,sensor}-scaffold.yaml` +
 * `junctions/site_sensor.yaml` — every entity `tenant_scoped: true` with
 * `soft_delete` and `user_tracking`, so every relation between them carries all
 * three guards. The depth-3 path is
 * `region { parentRegion { sites { sensors } } }`, whose last hop goes through the
 * junction.
 *
 * Nothing here asserts on emitted text. The manifest under test is the one the
 * CLI just generated, loaded by `./setup` and handed to
 * `drizzle({ client, relations })` exactly as a consumer's `database.module.ts`
 * does — so what these tests exercise is the same code path a real app takes,
 * including a hand-written `db.query.*` that never goes through a repository.
 *
 * `L9`–`L11` close the gap that left: they go through a GENERATED repository on a
 * scoped entity, which is the path every consumer actually takes and the one
 * nothing else here covered. The HTTP suite mounts deliberately UNSCOPED entities
 * (a scoped one is emitted `strict` and this harness has no auth boundary), and
 * the smoke only regex-matches emitted text — so a root predicate that renders
 * against the wrong table name was invisible to every gate until these.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

import type {
	getTestDb as GetTestDb,
	truncateAll as TruncateAll,
	closeDb as CloseDb,
} from './setup';
import type {
	regions as Regions,
	sites as Sites,
	sensors as Sensors,
	siteSensors as SiteSensors,
} from '../schema';

let getTestDb: typeof GetTestDb;
let truncateAll: typeof TruncateAll;
let closeDb: typeof CloseDb;
let regions: typeof Regions;
let sites: typeof Sites;
let sensors: typeof Sensors;
let siteSensors: typeof SiteSensors;
let withRequester: typeof import('@shared/base-classes/tenant-context').withRequester;
// The GENERATED repository for the scoped root — the real consumer path.
//
// `any` because it does not exist until the CLI has run: this suite imports it
// dynamically from `@gen/…`, which is codegen OUTPUT, so there is no type to
// name at authoring time. Same reason every other `@gen/…` handle in this
// harness is untyped (`http.test.ts`, `repository.test.ts`). What the shape has
// to be is asserted by the smoke's `tsc` over a real consumer project, not here.
let RegionRepository: any;

/** Tenant A reads; tenant B's rows are the poison. */
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** Two users inside tenant A — the `user_tracking` axis. */
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_OTHER = '44444444-4444-4444-8444-444444444444';

interface Seeded {
	parentRegionId: string;
	childRegionId: string;
	siteId: string;
	sensorId: string;
}

beforeAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	({ getTestDb, truncateAll, closeDb } = await import('./setup'));
	({ regions, sites, sensors, siteSensors } = await import('../schema'));
	({ withRequester } = await import('@shared/base-classes/tenant-context'));
	({ RegionRepository } = await import('@gen/modules/regions/region.repository'));
});

beforeEach(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await truncateAll();
});

afterAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await closeDb();
});

/** Read as tenant A / user A. */
function asA<T>(fn: () => Promise<T>): Promise<T> {
	return withRequester(
		{ userId: USER_A, organizationId: null, tenantId: TENANT_A },
		fn,
	);
}

/**
 * Seed tenant A's depth-3 graph, then plant a poison row at EVERY level:
 *
 *   depth 1 (parentRegion) — a tenant-B region, a soft-deleted region and
 *                            another user's region, each pointed at by a child
 *   depth 2 (sites)        — a tenant-B site, a soft-deleted site and another
 *                            user's site, all on tenant A's parent region
 *   depth 3 (sensors)      — a tenant-B sensor, a soft-deleted sensor and another
 *                            user's sensor, all linked to tenant A's site
 *
 * Inserts go through raw Drizzle, not a repository: the point is that the GRAPH
 * refuses to return them, not that a write path refuses to create them.
 */
async function seed(): Promise<Seeded> {
	const db = getTestDb();
	const mine = { tenantId: TENANT_A, userId: USER_A };

	const [parent] = await db
		.insert(regions)
		.values({ name: 'A Parent', ...mine })
		.returning();
	const [child] = await db
		.insert(regions)
		.values({ name: 'A Child', parentRegionId: parent!.id, ...mine })
		.returning();

	// depth-1 poison: children whose PARENT is not readable by A.
	const [foreignParent] = await db
		.insert(regions)
		.values({ name: 'B Parent', tenantId: TENANT_B, userId: USER_A })
		.returning();
	const [deletedParent] = await db
		.insert(regions)
		.values({ name: 'A Deleted Parent', ...mine, deletedAt: new Date() })
		.returning();
	const [otherUserParent] = await db
		.insert(regions)
		.values({ name: 'A OtherUser Parent', tenantId: TENANT_A, userId: USER_OTHER })
		.returning();
	await db.insert(regions).values([
		{ name: 'A Child of B Parent', parentRegionId: foreignParent!.id, ...mine },
		{ name: 'A Child of Deleted Parent', parentRegionId: deletedParent!.id, ...mine },
		{ name: 'A Child of OtherUser Parent', parentRegionId: otherUserParent!.id, ...mine },
	]);

	// depth 2: tenant A's own site on the PARENT region (so the depth-3 path
	// region → parentRegion → sites → sensors has something to return), plus
	// three poison siblings on the same parent.
	const [site] = await db
		.insert(sites)
		.values({ name: 'A Site', regionId: parent!.id, ...mine })
		.returning();
	await db.insert(sites).values([
		{ name: 'leak-B Site', regionId: parent!.id, tenantId: TENANT_B, userId: USER_A },
		{ name: 'leak-A Deleted Site', regionId: parent!.id, ...mine, deletedAt: new Date() },
		{
			name: 'leak-A OtherUser Site',
			regionId: parent!.id,
			tenantId: TENANT_A,
			userId: USER_OTHER,
		},
	]);

	// depth 3, through the junction: one readable sensor plus three poison ones,
	// all linked to tenant A's own site.
	const [sensor] = await db
		.insert(sensors)
		.values({ label: 'A Sensor', ...mine })
		.returning();
	const [foreignSensor] = await db
		.insert(sensors)
		.values({ label: 'B Sensor', tenantId: TENANT_B, userId: USER_A })
		.returning();
	const [deletedSensor] = await db
		.insert(sensors)
		.values({ label: 'A Deleted Sensor', ...mine, deletedAt: new Date() })
		.returning();
	const [otherUserSensor] = await db
		.insert(sensors)
		.values({ label: 'A OtherUser Sensor', tenantId: TENANT_A, userId: USER_OTHER })
		.returning();
	await db.insert(siteSensors).values([
		{ siteId: site!.id, sensorId: sensor!.id },
		{ siteId: site!.id, sensorId: foreignSensor!.id },
		{ siteId: site!.id, sensorId: deletedSensor!.id },
		{ siteId: site!.id, sensorId: otherUserSensor!.id },
	]);

	return {
		parentRegionId: parent!.id,
		childRegionId: child!.id,
		siteId: site!.id,
		sensorId: sensor!.id,
	};
}

/** The depth-3 traversal every leak test reads through. */
async function readDepth3(childRegionId: string) {
	const db = getTestDb();
	return db.query.regions.findMany({
		where: { id: { eq: childRegionId } },
		with: { parentRegion: { with: { sites: { with: { sensors: true } } } } },
	});
}

d('REL-2 leak tests — every hop of an include tree is scoped', () => {
	// ── L1 · the tenant axis, at every level ────────────────────────────────
	test('L1 — a depth-3 include as tenant A returns no tenant-B row at any level', async () => {
		const ids = await seed();

		await asA(async () => {
			const rows = await readDepth3(ids.childRegionId);
			expect(rows).toHaveLength(1);

			const parent = rows[0]!.parentRegion;
			expect(parent).not.toBeNull();
			expect(parent!.id).toBe(ids.parentRegionId);
			expect(parent!.tenantId).toBe(TENANT_A);

			// depth 2 — only tenant A's site, out of four on this region.
			expect(parent!.sites.map((s) => s.name)).toEqual(['A Site']);
			for (const site of parent!.sites) expect(site.tenantId).toBe(TENANT_A);

			// depth 3, through the junction — only tenant A's sensor, out of four
			// junction rows pointing at it.
			const sensorRows = parent!.sites[0]!.sensors;
			expect(sensorRows.map((s) => s.label)).toEqual(['A Sensor']);
			for (const sensor of sensorRows) expect(sensor.tenantId).toBe(TENANT_A);
		});
	});

	test('L1b — a child whose PARENT belongs to tenant B sees no parent at all', async () => {
		await seed();
		const db = getTestDb();

		await asA(async () => {
			const rows = await db.query.regions.findMany({
				where: { name: { eq: 'A Child of B Parent' } },
				with: { parentRegion: true },
			});
			expect(rows).toHaveLength(1);
			// The row exists and is tenant A's; the FK points at a row A may not read.
			// The include is `null`, not the foreign row — and not an error either.
			expect(rows[0]!.parentRegion).toBeNull();
		});
	});

	// ── L2 · the soft-delete axis, at every level ───────────────────────────
	test('L2 — a soft-deleted row is absent at every level of the same include', async () => {
		const ids = await seed();

		await asA(async () => {
			const rows = await readDepth3(ids.childRegionId);
			const parent = rows[0]!.parentRegion!;

			expect(parent.sites.map((s) => s.name)).not.toContain('leak-A Deleted Site');
			expect(parent.sites[0]!.sensors.map((s) => s.label)).not.toContain(
				'A Deleted Sensor',
			);

			// …and a soft-deleted PARENT is not reachable through the hop either.
			const orphan = await getTestDb().query.regions.findMany({
				where: { name: { eq: 'A Child of Deleted Parent' } },
				with: { parentRegion: true },
			});
			expect(orphan[0]!.parentRegion).toBeNull();
		});
	});

	// ── L3 · the user axis, at every level ──────────────────────────────────
	test('L3 — another user’s row is absent at every level of the same include', async () => {
		const ids = await seed();

		await asA(async () => {
			const rows = await readDepth3(ids.childRegionId);
			const parent = rows[0]!.parentRegion!;

			expect(parent.sites.map((s) => s.name)).not.toContain('leak-A OtherUser Site');
			expect(parent.sites[0]!.sensors.map((s) => s.label)).not.toContain(
				'A OtherUser Sensor',
			);

			const orphan = await getTestDb().query.regions.findMany({
				where: { name: { eq: 'A Child of OtherUser Parent' } },
				with: { parentRegion: true },
			});
			expect(orphan[0]!.parentRegion).toBeNull();
		});
	});

	test('L3b — the OTHER user sees their own rows and not A’s', async () => {
		await seed();
		const db = getTestDb();

		await withRequester(
			{ userId: USER_OTHER, organizationId: null, tenantId: TENANT_A },
			async () => {
				const rows = await db.query.regions.findMany({
					where: { name: { eq: 'A Child of OtherUser Parent' } },
					with: { parentRegion: true },
				});
				// This row belongs to USER_A, so the other user cannot even see the root
				// through a scoped repository — but `db.query` here is a raw traversal,
				// so the ROOT is unfiltered and only the HOP is scoped. The hop resolves
				// for them, which is exactly the asymmetry this test documents: the root
				// is TEN-1's to guard, the hop is REL-2's.
				expect(rows).toHaveLength(1);
				expect(rows[0]!.parentRegion).not.toBeNull();
				expect(rows[0]!.parentRegion!.userId).toBe(USER_OTHER);
			},
		);
	});

	// ── L4 · the §1.4 finding — the relational-filter form ──────────────────
	test('L4 — `where: { sites: … }` with NO `with:` is not an existence oracle', async () => {
		await seed();
		const db = getTestDb();

		await asA(async () => {
			// Three rows match `leak-%`: tenant B's, a soft-deleted one and another
			// user's. None of them is readable by A, so the EXISTS must not match —
			// even though the query asks for no include at all, which is precisely the
			// traversal an include-tree rewriter cannot see (REL-2 §1.4).
			const rows = await db.query.regions.findMany({
				where: { sites: { name: { like: 'leak-%' } } },
			});
			expect(rows).toEqual([]);

			// The same query for A's OWN site does match, so the filter is not simply
			// broken — it is scoped.
			const readable = await db.query.regions.findMany({
				where: { sites: { name: { eq: 'A Site' } } },
			});
			expect(readable.map((r) => r.name)).toEqual(['A Parent']);
		});
	});

	// ── L5 · the `.through()` hop ───────────────────────────────────────────
	test('L5 — the junction hop scopes the far side, in both directions', async () => {
		const ids = await seed();
		const db = getTestDb();

		await asA(async () => {
			const fromSite = await db.query.sites.findMany({
				where: { id: { eq: ids.siteId } },
				with: { sensors: true },
			});
			expect(fromSite[0]!.sensors.map((s) => s.label)).toEqual(['A Sensor']);

			// And back: tenant A's sensor sees tenant A's site, not the poison ones.
			const fromSensor = await db.query.sensors.findMany({
				where: { id: { eq: ids.sensorId } },
				with: { sites: true },
			});
			expect(fromSensor[0]!.sites.map((s) => s.name)).toEqual(['A Site']);
		});
	});

	// ── L6 · the §1.5 residual, pinned ──────────────────────────────────────
	test('L6 — a junction row carries no scope of its own (characterisation)', async () => {
		const ids = await seed();
		const db = getTestDb();

		// A junction table declares no scope, so `site_sensors` has no `tenant_id`
		// and no `deleted_at`: any junction row is anonymous. What that means,
		// measured rather than assumed:
		//
		//   - it can FABRICATE an edge between two of the reader's own rows;
		//   - it can NEVER surface another tenant's row, because the hop INTO the
		//     far table is scoped.
		//
		// The day junctions become scopable this goes red, which is the point.
		const [secondSensor] = await db
			.insert(sensors)
			.values({ label: 'A Second Sensor', tenantId: TENANT_A, userId: USER_A })
			.returning();
		await db.insert(siteSensors).values({ siteId: ids.siteId, sensorId: secondSensor!.id });

		await asA(async () => {
			const rows = await db.query.sites.findMany({
				where: { id: { eq: ids.siteId } },
				with: { sensors: true },
			});
			// The fabricated edge IS honoured — both rows are tenant A's.
			expect(rows[0]!.sensors.map((s) => s.label).sort()).toEqual([
				'A Second Sensor',
				'A Sensor',
			]);
			for (const sensor of rows[0]!.sensors) expect(sensor.tenantId).toBe(TENANT_A);
		});

		// The junction table itself has neither scope column — the fact that makes
		// the above a write-path property, not a read-path one.
		const columns = Object.keys(siteSensors);
		expect(columns).not.toContain('tenantId');
		expect(columns).not.toContain('deletedAt');
	});

	// ── L7 / L8 · the enforcement boundary ──────────────────────────────────
	test('L7 — a traversing query with no ambient context throws before any SQL', async () => {
		await seed();
		const db = getTestDb();

		// `tenant_scoped: true` ⇒ `enforcement: 'strict'` (TEN-1 §3.4), so a missing
		// boundary is a throw at query BUILD, not an unscoped read. Asserted by
		// building the statement — no SQL is sent.
		expect(() =>
			db.query.regions
				.findMany({ with: { parentRegion: true } })
				.toSQL(),
		).toThrow(/No requester context active/);
	});

	// ── L9–L11 · through a GENERATED repository, which is the consumer path ──
	test('L9 — a generated repository EXECUTES an include on a scoped entity', async () => {
		const ids = await seed();
		const repo = new RegionRepository(getTestDb());

		await asA(async () => {
			// The regression this exists for: the RQBv2 root filter has to be built
			// against the table the query builder hands the closure, not against the
			// repository's own handle. RQBv2 aliases the root (`from "regions" as
			// "d0"`), so a predicate naming `regions` is a missing-FROM-clause error
			// and EVERY include on a scoped entity fails to execute. Nothing else in
			// the suite caught it: the HTTP entities are unscoped, so their root
			// predicate renders `true` and references no column at all.
			const row = await repo.findById(ids.childRegionId, {
				with: { parentRegion: { with: { sites: true } } },
			});

			expect(row).not.toBeNull();
			expect(row.id).toBe(ids.childRegionId);
			expect(row.parentRegion.id).toBe(ids.parentRegionId);
			// …and the hops are still scoped through this path.
			expect(row.parentRegion.sites.map((s: { name: string }) => s.name)).toEqual([
				'A Site',
			]);
		});
	});

	test('L10 — the ROOT predicate applies through the repository, not just the hops', async () => {
		const ids = await seed();
		const db = getTestDb();
		const repo = new RegionRepository(db);

		// Soft-delete the root itself. `region` declares `soft_delete`, so the root
		// filter must exclude it — through the include path exactly as through
		// `baseQuery()`.
		await db
			.update(regions)
			.set({ deletedAt: new Date() })
			.where(eq(regions.id, ids.childRegionId));

		await asA(async () => {
			expect(await repo.findById(ids.childRegionId, { with: { parentRegion: true } })).toBeNull();
			// The include-free path agrees — one predicate, two builders.
			expect(await repo.findById(ids.childRegionId)).toBeNull();
		});
	});

	test('L11 — list() with an include paginates and sorts through the same path', async () => {
		await seed();
		const repo = new RegionRepository(getTestDb());

		await asA(async () => {
			const rows = await repo.list({
				limit: 2,
				offset: 0,
				sort: [{ column: 'name', direction: 'asc' }],
				with: { sites: true },
			});

			expect(rows).toHaveLength(2);
			// Sorted by the ALIASED root table — a pre-rendered `orderBy` would name
			// `regions` and fail the same way the root predicate did.
			expect(rows.map((r: { name: string }) => r.name)).toEqual([
				'A Child',
				'A Child of B Parent',
			]);
			for (const row of rows) expect(Array.isArray(row.sites)).toBe(true);
		});
	});

	test('L8 — a read with NO include is untouched: the hop predicate never runs', async () => {
		const ids = await seed();
		const db = getTestDb();

		// No context, no include — and it works, returning every row including the
		// ones a scoped traversal would hide. Root scoping is TEN-1's; REL-2 changes
		// nothing here, which is what makes it additive.
		const rows = await db.query.regions.findMany({ where: { id: { eq: ids.childRegionId } } });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe(ids.childRegionId);

		// Same for the UNSCOPED graph the REL-1 round-trip uses: no scope declared
		// anywhere, so no hop predicate is emitted and no context is needed.
		const { accounts } = await import('../schema');
		const [account] = await db.insert(accounts).values({ name: 'Unscoped' }).returning();
		const unscoped = await db.query.accounts.findMany({
			where: { id: { eq: account!.id } },
			with: { contacts: true, opportunities: true },
		});
		expect(unscoped).toHaveLength(1);
		expect(unscoped[0]!.contacts).toEqual([]);
	});
});
