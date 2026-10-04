/**
 * SEM-3 — the demonstration gate: the emitted semantic model answers a
 * fan-out-trap measure correctly, against real Postgres.
 *
 * WHAT THIS PROVES that nothing else does. The golden snapshot pins the emitted
 * model's TEXT; the relationship smoke pins that it COMPILES. Neither says the
 * model is *correct*. This suite executes the **checked-in emitted artifact**
 * (`test/semantic-golden/snapshot/model.ts` — not a hand-written stand-in)
 * through `@pattern-stack/query-surface`'s own engine and asserts the rows.
 *
 * THE TRAP. Sum a child's money column over a `has_many`, group at the parent's
 * grain, and ask anything else about the parent in the same query: a naive
 * single-pass join counts the parent once per child row. The engine splits the
 * query per source entity (`needsCte: true`) and joins the collapsed results,
 * so the parent is counted once. This suite asserts BOTH sides — the engine's
 * answer and the wrong answer a naive join gives — so it demonstrates the trap
 * rather than assuming it.
 *
 * WHERE THE ENGINE COMES FROM:
 *   - the installed `@pattern-stack/query-surface` — a devDependency of this
 *     repo, pinned exactly (SEM-4, #694). This is what CI runs. It is
 *     REQUIRED: if it does not resolve or load, the suite fails. An absent
 *     engine is not a reason to skip once the repo depends on it.
 *   - `QUERY_SURFACE_PATH` — an explicit checkout, for running the emitted
 *     model against unreleased engine work. Setting it is a demand to run: a
 *     missing path, or ANY load error, FAILS the suite.
 *
 * ONE SKIP, named and printed (charter I9 — a skip with a stated reason is not
 * a filter): no Docker → the `obs-list-reads` precedent. The CI `integration`
 * job has Docker, so there it runs.
 *
 * WHY A CHECKOUT IS STAGED INTO THIS REPO. The checkout has no
 * `node_modules`, and nothing between it and `/` does either, so a bare
 * `drizzle-orm` specifier inside it resolves differently under `bun test` than
 * under `bun <script>` — it failed outright in the former. That is the charter's
 * §8 "probing against the wrong copy" hazard in its most dangerous form: a run
 * that *succeeds* against a stale 0.45 copy proves nothing about 1.0. Copying
 * `src/` under this repo makes resolution structural — the only `node_modules`
 * on the path up is this repo's, pinned to 1.0.0-rc.4 — so ONE drizzle copy is
 * shared by the engine, the table objects and the db handle. A cross-copy
 * mismatch would fail loudly anyway: the package's `is(x, PgTable)` checks are
 * identity-based (the dual-type-identity hazard `init-scaffold.ts` documents).
 * The INSTALLED package needs no staging: it resolves drizzle-orm as a peer from
 * this repo's `node_modules`.
 *
 * Runs via `just test-semantic-integration` and the CI `integration` job.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { buildAggregateModel } from '../semantic-golden/snapshot/model';

// ────────────────────────────────────────────────────────────────────────────
// Preconditions — the engine (required) and Docker (the one named skip).
// ────────────────────────────────────────────────────────────────────────────

const PACKAGE = '@pattern-stack/query-surface';

type EngineSource = { kind: 'installed' } | { kind: 'explicit'; root: string };

function findEngine(): EngineSource {
	const fromEnv = process.env.QUERY_SURFACE_PATH;
	return fromEnv ? { kind: 'explicit', root: fromEnv } : { kind: 'installed' };
}

async function dockerIsAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/** Where a staged checkout lives — gitignored, and created on demand (a fresh
 *  clone has no `test/tmp/`, and `mkdtemp` does not create parents). */
const STAGE_ROOT = resolve(import.meta.dir, '../tmp');

/**
 * Copy a checkout's `src/` under this repo so its bare imports resolve against
 * this repo's `node_modules` (drizzle-orm 1.0.0-rc.4) — see the header.
 * `__tests__` is skipped: it is a third of the tree and none of it is imported.
 */
function stagePackage(root: string): string {
	mkdirSync(STAGE_ROOT, { recursive: true });
	const dir = mkdtempSync(resolve(STAGE_ROOT, 'query-surface-'));
	cpSync(resolve(root, 'src'), resolve(dir, 'src'), {
		recursive: true,
		filter: (src) => !src.endsWith('/__tests__'),
	});
	return dir;
}

type Engine = Record<string, (...args: never[]) => never> & Record<string, unknown>;

/** Load the engine, staging a checkout first. Returns the staged dir to clean up. */
async function loadEngine(source: EngineSource): Promise<{ qs: Engine; staged: string | null }> {
	if (source.kind === 'installed') {
		return { qs: (await import(PACKAGE)) as unknown as Engine, staged: null };
	}
	if (!existsSync(resolve(source.root, 'src/index.ts'))) {
		throw new Error(`QUERY_SURFACE_PATH=${source.root} has no src/index.ts`);
	}
	const staged = stagePackage(source.root);
	try {
		return { qs: (await import(resolve(staged, 'src/index.ts'))) as unknown as Engine, staged };
	} catch (err) {
		rmSync(staged, { recursive: true, force: true });
		throw err;
	}
}

const SOURCE = findEngine();
const DOCKER_OK = await dockerIsAvailable();

/**
 * Load once, up front. Any load error is kept and rethrown by the always-on
 * check below and by `beforeAll`, so it FAILS the run — there is no load error
 * that skips.
 */
let loaded: { qs: Engine; staged: string | null } | null = null;
let loadError: unknown = null;
try {
	loaded = await loadEngine(SOURCE);
} catch (err) {
	loadError = err;
}

if (!DOCKER_OK) {
	console.warn('[SEM-3 fan-out] SKIPPED — Docker not available; no Postgres to query.');
}
console.log(
	`[SEM-3 fan-out] engine: ${SOURCE.kind} (${SOURCE.kind === 'explicit' ? SOURCE.root : PACKAGE})`,
);

/** Run unless Docker is missing. A load error leaves this true, so
 *  `beforeAll` rethrows it and the suite fails. */
const RUN = DOCKER_OK;

/**
 * Runs ALWAYS — even without Docker — so a load error fails the run instead of
 * hiding behind the Docker skip.
 */
describe('SEM-3 — the semantic engine loads', () => {
	it(`the ${SOURCE.kind} engine loads`, () => {
		if (loadError !== null) throw loadError;
	});
});

// ────────────────────────────────────────────────────────────────────────────
// The slice. DDL mirrors `test/semantic-golden/schema.ts`, which is the
// stand-in for the generated barrel the emitted model imports.
// ────────────────────────────────────────────────────────────────────────────

const ACME = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';
const TENANT = '99999999-9999-9999-9999-999999999999';

const DDL = [
	`create table accounts (
		id uuid primary key, name text not null, tenant_id uuid not null,
		annual_revenue numeric, health_score numeric, tier text, website text,
		external_id text, created_at timestamp not null default now(),
		updated_at timestamp not null default now())`,
	`create table contacts (
		id uuid primary key default gen_random_uuid(), first_name text, last_name text,
		email text, account_id uuid not null references accounts(id),
		primary_for_account_id uuid, tags text[], linked_to_entity_type text,
		linked_to_entity_id uuid)`,
	`create table opportunities (
		id uuid primary key default gen_random_uuid(), name text not null,
		amount numeric, won_amount numeric, win_probability numeric, stage text,
		closed_at timestamp, account_id uuid not null references accounts(id))`,
	`create table opportunity_contacts (
		opportunity_id uuid not null references opportunities(id),
		contact_id uuid not null references contacts(id), role text not null,
		is_primary boolean not null default false, started_at timestamp,
		ended_at timestamp, sourced_from text, confidence numeric(5,4),
		matched_at timestamp, influence_score numeric,
		created_at timestamp not null default now(),
		updated_at timestamp not null default now(),
		primary key (opportunity_id, contact_id, role))`,
];

/** The engine is schema-agnostic and the checkout is untyped from here, so the
 *  two handles below are intentionally loose. Everything asserted about them is
 *  checked at runtime against real rows. */

let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle>;
let qs: Engine;
let model: ReturnType<typeof buildAggregateModel>;

beforeAll(async () => {
	if (!RUN) return;
	if (loadError !== null) throw loadError;
	qs = loaded!.qs;
	const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
	container = await new PostgreSqlContainer('postgres:16').start();
	pool = new Pool({ connectionString: container.getConnectionUri() });
	db = drizzle({ client: pool });

	for (const stmt of DDL) await db.execute(sql.raw(stmt));

	// Acme has TWO opportunities — that is what makes the trap bite. Globex has
	// one, so a naive join happens to be right for it; asserting both rows keeps
	// the test from passing on a coincidence.
	await db.execute(sql.raw(`insert into accounts (id, name, tenant_id, annual_revenue, health_score, tier) values
		('${ACME}', 'Acme', '${TENANT}', 1000000, 0.80, 'gold'),
		('${GLOBEX}', 'Globex', '${TENANT}', 250000, 0.40, 'silver')`));
	await db.execute(sql.raw(`insert into opportunities (name, amount, won_amount, win_probability, stage, closed_at, account_id) values
		('A1', 100, 100, 0.90, 'closed_won', '2026-01-15', '${ACME}'),
		('A2', 250,   0, 0.50, 'negotiation', '2026-02-20', '${ACME}'),
		('G1',  75,  75, 0.70, 'closed_won', '2026-01-31', '${GLOBEX}')`));

	model = buildAggregateModel();
}, 120_000);

afterAll(async () => {
	if (loaded?.staged) rmSync(loaded.staged, { recursive: true, force: true });
	if (!RUN) return;
	await pool?.end();
	await container?.stop();
});

// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('SEM-3 — describe over the emitted model', () => {
	it('derives the atomic measure catalog from the emitted field tags', () => {
		// SEM-2 emits NO atomic entries; the package derives them. This is that
		// contract checked against the real deriver rather than restated.
		const catalog = qs.measuresFromRegistry(model.analytics);
		const keys = Object.keys(catalog).sort();

		// `aggs:` → one `field.agg` key per allowed agg.
		expect(keys).toContain('amount.sum');
		expect(keys).toContain('amount.avg');
		expect(keys).toContain('amount.min');
		expect(keys).toContain('amount.max');
		// single `agg:` → the bare field name.
		expect(keys).toContain('health_score');
		expect(keys).toContain('win_probability');

		// Additivity is field-authoritative, and only sum/count inherit it.
		expect(catalog['amount.sum'].additivity).toBe('additive');
		expect(catalog['amount.avg'].additivity).toBe('non');
		expect(catalog.win_probability.additivity).toBe('non');
	});

	it('surfaces the emitted dimensions, including the to-one reach', () => {
		const dims = qs.conformedDimensions(model.analytics, 'opportunity');
		const byPath = new Map(dims.map((d: { path: string }) => [d.path, d]));

		expect(byPath.get('stage')).toMatchObject({ owner: 'opportunity', via: 'local' });
		expect(byPath.get('closed_at')).toMatchObject({ type: 'datetime', via: 'local' });
		// Reached through `belongs_to account`, derived from the emitted graph.
		expect(byPath.get('account.name')).toMatchObject({ owner: 'account', via: 'to-one' });
		// SEM-3: a behavior-contributed column is groupable because the emitter
		// gives it `role: 'dimension'` — an untagged column would not appear.
		expect(byPath.has('account.created_at')).toBe(true);
	});

	it('accepts the emitted `has_one` edge', () => {
		expect(model.analytics.account.rels.primary_contact.kind).toBe('has_one');
		// The package knows the kind (query-surface#41): discovery walks it as a
		// to-one edge rather than rejecting the model.
		const dims = qs.conformedDimensions(model.analytics, 'account');
		expect(Array.isArray(dims)).toBe(true);
	});
});

describe.skipIf(!RUN)('SEM-3 — the fan-out trap', () => {
	/** sum over the has_many, plus a measure at the PARENT grain. */
	const trapQuery = {
		entity: 'account',
		group_by: ['account.name'],
		measures: [
			{ on: 'amount', agg: 'sum', source: 'opportunity', as: 'pipeline' },
			{ on: '*', agg: 'count', source: 'account', as: 'accounts' },
		],
	};

	it('the grain oracle reports no findings for the query', () => {
		expect(qs.diagnoseAggregate(model.analytics, trapQuery)).toEqual([]);
	});

	it('plans a per-source pre-aggregation (needsCte) at the parent grain', async () => {
		const result = await qs.runAggregateDrizzle(db, model, trapQuery);
		expect(result.plan).toMatchObject({
			groupGrain: 'account',
			needsCte: true,
			rootJoinWouldFan: true,
		});
		expect([...result.plan.sources].sort()).toEqual(['account', 'opportunity']);
	});

	it('returns the CORRECT rows — the parent counted once, not once per child', async () => {
		const result = await qs.runAggregateDrizzle(db, model, trapQuery);
		const byName = Object.fromEntries(
			result.rows.map((r: Record<string, unknown>) => [r['account.name'], r]),
		);
		// Acme: 100 + 250 pipeline across TWO opportunities, but ONE account.
		expect(Number(byName.Acme.pipeline)).toBe(350);
		expect(Number(byName.Acme.accounts)).toBe(1);
		expect(Number(byName.Globex.pipeline)).toBe(75);
		expect(Number(byName.Globex.accounts)).toBe(1);
	});

	it('and a naive single-pass join gets it WRONG — the trap is real', async () => {
		// The same question asked the obvious way. If this ever returns 1 for
		// Acme the fixture has stopped containing a fan-out and the assertions
		// above stop meaning anything.
		const naive = await db.execute(sql`
			select a.name, sum(o.amount) as pipeline, count(a.id) as accounts
			from opportunities o left join accounts a on o.account_id = a.id
			group by a.name`);
		const byName = Object.fromEntries(
			naive.rows.map((r: Record<string, unknown>) => [r.name, r]),
		);
		expect(Number(byName.Acme.pipeline)).toBe(350);
		expect(Number(byName.Acme.accounts)).toBe(2); // ← double-counted
	});

	it('a single cross-has_many measure is correct but needs no CTE', async () => {
		// Documents the boundary: `needsCte` is `sources.length > 1`, so one
		// measure over the has_many plans false while still flagging that a
		// naive root join WOULD fan (SEM-3 spec T7).
		const result = await qs.runAggregateDrizzle(db, model, {
			entity: 'account',
			group_by: ['account.name'],
			measures: [{ on: 'amount', agg: 'sum', source: 'opportunity', as: 'pipeline' }],
		});
		expect(result.plan).toMatchObject({ needsCte: false, rootJoinWouldFan: true });
		const byName = Object.fromEntries(
			result.rows.map((r: Record<string, unknown>) => [r['account.name'], r]),
		);
		expect(Number(byName.Acme.pipeline)).toBe(350);
	});

	it('honours the emitted enum dimension as a group key', async () => {
		const result = await qs.runAggregateDrizzle(db, model, {
			entity: 'opportunity',
			group_by: ['stage'],
			measures: [{ on: 'amount', agg: 'sum', source: 'opportunity', as: 'total' }],
		});
		const byStage = Object.fromEntries(
			result.rows.map((r: Record<string, unknown>) => [r.stage, Number(r.total)]),
		);
		expect(byStage.closed_won).toBe(175);
		expect(byStage.negotiation).toBe(250);
	});
});
