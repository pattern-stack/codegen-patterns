/**
 * REL-1 (#586) — the charter §9 round-trip gate.
 *
 * YAML → `defineRelations()` manifest → a nested `db.query.X.findMany({ with })`
 * that returns the expected ROWS against real Postgres. Nothing here asserts on
 * the emitted text: the manifest under test is the one the CLI just generated
 * from `test/scaffold/entities/` + `test/scaffold/junctions/`, loaded by
 * `./setup` and handed to `drizzle({ client, relations })` exactly as a consumer
 * project's `database.module.ts` does.
 *
 * Covers, in one traversal:
 *   - a SELF-REFERENTIAL `one()`            (account.parentAccount)
 *   - `has_many` whose FK is on the target  (account.contacts / .opportunities)
 *   - a NOT NULL `one()` inverse            (opportunity.account)
 *   - the many-to-many `.through()` hop     (opportunity.contacts, both ways)
 *   - the row-level edge to the junction    (opportunity.opportunityContacts)
 *   - depth 3 from a single root
 *   - `optional: true` really yielding null (an account with no parent)
 *
 * Gated behind SCAFFOLD_INTEGRATION=1 — see ./_skip-guard.ts.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

import type { getTestDb as GetTestDb, truncateAll as TruncateAll, closeDb as CloseDb } from './setup';
import type { accounts as Accounts, contacts as Contacts, opportunities as Opportunities, opportunityContacts as OpportunityContacts } from '../schema';

let getTestDb: typeof GetTestDb;
let truncateAll: typeof TruncateAll;
let closeDb: typeof CloseDb;
let accounts: typeof Accounts;
let contacts: typeof Contacts;
let opportunities: typeof Opportunities;
let opportunityContacts: typeof OpportunityContacts;

/** Ids of the graph seeded by `seed()`, so assertions can name exact rows. */
interface Seeded {
	parentAccountId: string;
	childAccountId: string;
	contactId: string;
	opportunityId: string;
}

beforeAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	({ getTestDb, truncateAll, closeDb } = await import('./setup'));
	({ accounts, contacts, opportunities, opportunityContacts } = await import('../schema'));
});

beforeEach(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await truncateAll();
});

afterAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await closeDb();
});

/** Parent ← Child ← (contact, opportunity) ← junction row. */
async function seed(): Promise<Seeded> {
	const db = getTestDb();

	const [parent] = await db
		.insert(accounts)
		.values({ name: 'Parent Holdings' })
		.returning();
	const [child] = await db
		.insert(accounts)
		.values({ name: 'Child Division', parentAccountId: parent!.id })
		.returning();
	const [contact] = await db
		.insert(contacts)
		.values({
			accountId: child!.id,
			firstName: 'Ada',
			lastName: 'Lovelace',
			email: `rel-${Date.now()}@example.com`,
		})
		.returning();
	const [opportunity] = await db
		.insert(opportunities)
		.values({ accountId: child!.id, name: 'Analytical Engine' })
		.returning();
	await db.insert(opportunityContacts).values({
		opportunityId: opportunity!.id,
		contactId: contact!.id,
		role: 'champion',
	});

	return {
		parentAccountId: parent!.id,
		childAccountId: child!.id,
		contactId: contact!.id,
		opportunityId: opportunity!.id,
	};
}

d('REL-1 relations manifest round-trip', () => {
	test('a single nested traversal returns the whole declared graph', async () => {
		const ids = await seed();
		const db = getTestDb();

		const rows = await db.query.accounts.findMany({
			where: { name: 'Child Division' },
			with: {
				parentAccount: true,
				contacts: true,
				opportunities: {
					with: { account: true, contacts: true, opportunityContacts: true },
				},
			},
		});

		expect(rows).toHaveLength(1);
		const child = rows[0]!;
		expect(child.id).toBe(ids.childAccountId);

		// Self-referential one().
		expect(child.parentAccount).not.toBeNull();
		expect(child.parentAccount!.id).toBe(ids.parentAccountId);
		expect(child.parentAccount!.name).toBe('Parent Holdings');

		// has_many, FK on the target table.
		expect(child.contacts.map((c) => c.id)).toEqual([ids.contactId]);
		expect(child.opportunities.map((o) => o.id)).toEqual([ids.opportunityId]);

		const opportunity = child.opportunities[0]!;
		// NOT NULL one() inverse, at depth 2.
		expect(opportunity.account.id).toBe(ids.childAccountId);
		// The many-to-many `.through()` hop, at depth 2.
		expect(opportunity.contacts.map((c) => c.id)).toEqual([ids.contactId]);
		// The row-level edge carries the junction's own columns.
		expect(opportunity.opportunityContacts).toHaveLength(1);
		expect(opportunity.opportunityContacts[0]!.role).toBe('champion');
	});

	test('the many-to-many hop traverses in the other direction too', async () => {
		const ids = await seed();
		const db = getTestDb();

		const rows = await db.query.contacts.findMany({
			with: { opportunities: { with: { account: true } }, account: true },
		});

		expect(rows).toHaveLength(1);
		const contact = rows[0]!;
		expect(contact.account).not.toBeNull();
		expect(contact.account!.id).toBe(ids.childAccountId);
		expect(contact.opportunities.map((o) => o.id)).toEqual([ids.opportunityId]);
		expect(contact.opportunities[0]!.account.id).toBe(ids.childAccountId);
	});

	test('an optional one() yields null when the row has no parent', async () => {
		const ids = await seed();
		const db = getTestDb();

		const rows = await db.query.accounts.findMany({
			where: { id: ids.parentAccountId },
			with: { parentAccount: true, contacts: true, opportunities: true },
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]!.parentAccount).toBeNull();
		// …and an empty to-many is an empty array, not undefined.
		expect(rows[0]!.contacts).toEqual([]);
		expect(rows[0]!.opportunities).toEqual([]);
	});

	test('depth 4 — has_many → through → one → self-ref one — from one root', async () => {
		const ids = await seed();
		const db = getTestDb();

		// account → opportunities → (through the junction) contacts → account
		// → parentAccount. Four hops, one root, one statement.
		const deep = await db.query.accounts.findMany({
			where: { id: ids.childAccountId },
			with: {
				opportunities: {
					with: { contacts: { with: { account: { with: { parentAccount: true } } } } },
				},
			},
		});

		expect(deep).toHaveLength(1);
		const account = deep[0]!.opportunities[0]!.contacts[0]!.account!;
		expect(account.id).toBe(ids.childAccountId);
		expect(account.parentAccount!.id).toBe(ids.parentAccountId);
	});
});
