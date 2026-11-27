/**
 * The generated junction service's writes, on Postgres: `attach`, `setPrimary` and `detach` address a row by its
 * pair (a junction table has no `id` column). `detach` / `setPrimary` used to look a row up and then delete / update
 * it by `match.id`, which threw `table has no column 'id'` for every junction.
 */
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { SHOULD_RUN_SCAFFOLD, d } from './_skip-guard';

let getTestDb: any;
let truncateAll: any;
let closeDb: any;
let accounts: any;
let contacts: any;
let opportunities: any;
let service: any;
let repository: any;

beforeAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	({ getTestDb, truncateAll, closeDb } = await import('./setup'));
	({ accounts, contacts, opportunities } = await import('../schema'));
	const { OpportunityContactRepository } = await import(
		'@gen/modules/opportunity-contacts/opportunity-contact.repository'
	);
	const { OpportunityContactService } = await import('@gen/modules/opportunity-contacts/opportunity-contact.service');
	const { OpportunityRepository } = await import('@gen/modules/opportunities/opportunity.repository');
	const { ContactRepository } = await import('@gen/modules/contacts/contact.repository');
	const db = getTestDb();
	repository = new OpportunityContactRepository(db);
	service = new OpportunityContactService(repository, new OpportunityRepository(db), new ContactRepository(db));
});

beforeEach(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await truncateAll();
});

afterAll(async () => {
	if (!SHOULD_RUN_SCAFFOLD) return;
	await closeDb();
});

async function seed(): Promise<{ opportunityId: string; contactIds: [string, string] }> {
	const db = getTestDb();
	const [account] = await db.insert(accounts).values({ name: 'Junction Holdings' }).returning();
	const people = await db
		.insert(contacts)
		.values([
			{ accountId: account.id, firstName: 'Ada', lastName: 'Lovelace', email: `j1-${Date.now()}@example.com` },
			{ accountId: account.id, firstName: 'Alan', lastName: 'Turing', email: `j2-${Date.now()}@example.com` },
		])
		.returning();
	const [opportunity] = await db.insert(opportunities).values({ accountId: account.id, name: 'Engine' }).returning();
	return { opportunityId: opportunity.id, contactIds: [people[0].id, people[1].id] };
}

d('junction service writes, by the pair', () => {
	test('detach removes only the named link', async () => {
		const { opportunityId, contactIds } = await seed();
		await service.attach(opportunityId, contactIds[0], { role: 'champion' });
		await service.attach(opportunityId, contactIds[1], { role: 'influencer' });

		await service.detach(opportunityId, contactIds[0]);

		const left = await repository.findByOpportunityId(opportunityId);
		expect(left.map((l: any) => l.contactId)).toEqual([contactIds[1]]);
	});

	test('detach of a pair that is not linked is a no-op', async () => {
		const { opportunityId, contactIds } = await seed();
		await service.detach(opportunityId, contactIds[0]);
		expect(await repository.findByOpportunityId(opportunityId)).toEqual([]);
	});

	test('detach and setPrimary publish the junction lifecycle events, keyed by the pair', async () => {
		const { opportunityId, contactIds } = await seed();
		const published: { type: string; aggregateId: string }[] = [];
		const bus = {
			publish: async (e: any) => void published.push(e),
			publishMany: async (es: any[]) => void published.push(...es),
		};
		service.eventBus = bus;
		try {
			await service.attach(opportunityId, contactIds[0], { role: 'champion' });
			await service.setPrimary(opportunityId, contactIds[0]);
			await service.detach(opportunityId, contactIds[0]);
			await service.detach(opportunityId, contactIds[0]); // not linked: no event
		} finally {
			service.eventBus = undefined;
		}
		const key = `${opportunityId}:${contactIds[0]}`;
		expect(published.filter((e) => e.type !== 'opportunity_contact.created').map((e) => [e.type, e.aggregateId])).toEqual([
			['opportunity_contact.updated', key],
			['opportunity_contact.deleted', key],
		]);
	});

	test('setPrimary marks the named link primary and leaves the other', async () => {
		const { opportunityId, contactIds } = await seed();
		await service.attach(opportunityId, contactIds[0], { role: 'champion' });
		await service.attach(opportunityId, contactIds[1], { role: 'influencer' });

		await service.setPrimary(opportunityId, contactIds[1]);

		const rows = await repository.findByOpportunityId(opportunityId);
		const primary = Object.fromEntries(rows.map((r: any) => [r.contactId, r.isPrimary]));
		expect(primary).toEqual({ [contactIds[0]]: false, [contactIds[1]]: true });
	});
});
