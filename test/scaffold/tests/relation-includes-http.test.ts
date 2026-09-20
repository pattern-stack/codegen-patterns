/**
 * REL-2 (#587) §5 — the HTTP include allowlist, over the real Nest stack.
 *
 * Charter I6: includes over HTTP are a YAML allowlist. A client names dot PATHS;
 * the generated controller looks each one up in a compile-time literal map and
 * rejects anything the map does not name. A route with no `api.includes` entry
 * exposes nothing, which is the state every entity is in until a consumer opts in.
 *
 * The controllers under test are the GENERATED ones, mounted as-emitted by
 * `src/app.module.ts`:
 *
 *   - `/accounts` declares `api.includes` for `find_by_id` and `list`, naming
 *     `contacts` only. `opportunities` is a real relation that is deliberately
 *     absent, so a 400 there is the allowlist working, not a typo.
 *   - `/opportunities` HAS relations in the graph (`account`, `contacts`) and
 *     declares no allowlist at all — so every one of them is a 400.
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import 'reflect-metadata';
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

let Test: any;
let AppModule: any;
let supertest: any;
let truncateAll: any;
let closeDb: any;
let getTestDb: any;
let accounts: any;
let contacts: any;

let app: any;
let request: any;

beforeAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	({ Test } = await import('@nestjs/testing'));
	({ AppModule } = await import('../src/app.module'));
	supertest = (await import('supertest')).default;
	({ truncateAll, closeDb, getTestDb } = await import('./setup'));
	({ accounts, contacts } = await import('../schema'));

	const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
	app = moduleRef.createNestApplication();
	await app.init();
	request = supertest(app.getHttpServer());
});

beforeEach(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await truncateAll();
});

afterAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await app?.close();
	await closeDb();
});

/** One account with one contact on it, so an include has something to return. */
async function seed(): Promise<{ accountId: string; contactEmail: string }> {
	const db = getTestDb();
	const [account] = await db.insert(accounts).values({ name: 'Acme' }).returning();
	const email = `http-include-${Date.now()}@example.com`;
	await db
		.insert(contacts)
		.values({ accountId: account.id, firstName: 'Ada', lastName: 'L', email })
		.returning();
	return { accountId: account.id, contactEmail: email };
}

d('REL-2 §5 — the HTTP include allowlist', () => {
	// ── H1 · an allowlisted path resolves ───────────────────────────────────
	test('H1 — ?include=contacts on an allowlisted route returns the include', async () => {
		const { accountId, contactEmail } = await seed();

		const res = await request.get(`/accounts/${accountId}?include=contacts`).expect(200);
		expect(res.body.id).toBe(accountId);
		expect(Array.isArray(res.body.contacts)).toBe(true);
		expect(res.body.contacts.map((c: { email: string }) => c.email)).toEqual([contactEmail]);
	});

	test('H1b — the same path is allowlisted on the list route', async () => {
		const { contactEmail } = await seed();

		const res = await request.get('/accounts?include=contacts').expect(200);
		expect(res.body.items).toHaveLength(1);
		expect(res.body.items[0].contacts.map((c: { email: string }) => c.email)).toEqual([
			contactEmail,
		]);
	});

	test('H1c — no ?include= at all returns the plain row, unchanged', async () => {
		const { accountId } = await seed();

		const res = await request.get(`/accounts/${accountId}`).expect(200);
		expect(res.body.id).toBe(accountId);
		expect(res.body.contacts).toBeUndefined();
	});

	// ── H2 · a real relation that is not allowlisted ────────────────────────
	test('H2 — a REAL relation the allowlist does not name is a 400, naming the path', async () => {
		const { accountId } = await seed();

		const res = await request.get(`/accounts/${accountId}?include=opportunities`).expect(400);
		expect(res.body.code).toBe('include_not_allowed');
		expect(res.body.path).toBe('opportunities');
	});

	test('H2b — one bad path rejects the whole request, even beside a good one', async () => {
		const { accountId } = await seed();

		const res = await request
			.get(`/accounts/${accountId}?include=contacts,parentAccount`)
			.expect(400);
		expect(res.body.path).toBe('parentAccount');
	});

	test('H2c — a path DEEPER than the allowlist names is a 400', async () => {
		const { accountId } = await seed();

		// `max_depth` is 1 here and only `contacts` is named, so the deeper shape was
		// never compiled into the map — it cannot be requested.
		const res = await request
			.get(`/accounts/${accountId}?include=contacts.account`)
			.expect(400);
		expect(res.body.path).toBe('contacts.account');
	});

	test('H2d — a misspelled path is a 400, not a silent ignore', async () => {
		const { accountId } = await seed();

		await request.get(`/accounts/${accountId}?include=contactz`).expect(400);
	});

	// ── H4 · closed by default ──────────────────────────────────────────────
	test('H4 — any ?include= on a route with NO allowlist is a 400', async () => {
		// `account` IS a relation on opportunity, and it is still rejected: the route
		// declares no `api.includes`, and that is not "allow everything".
		const res = await request.get('/opportunities?include=account').expect(400);
		expect(res.body.code).toBe('include_not_allowed');
		expect(res.body.path).toBe('account');
	});

	test('H4b — that route still serves its plain read', async () => {
		await request.get('/opportunities').expect(200);
	});

	test('H4c — an empty ?include= is not a request for an include', async () => {
		const { accountId } = await seed();
		await request.get(`/accounts/${accountId}?include=`).expect(200);
		await request.get('/opportunities?include=').expect(200);
	});
});
