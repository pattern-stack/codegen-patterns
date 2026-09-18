/**
 * Stand-in for the generated Drizzle schema barrel (SEM-3).
 *
 * `snapshot/model.ts` — the checked-in EMITTED semantic model — does
 * `import * as schema from '../schema'`. In a real project that resolves to
 * `<paths.generated>/schema.ts`, which re-exports every entity's generated
 * `pgTable`. The golden fixture tree has no generated code, so without this
 * file the snapshot could be diffed but never RUN.
 *
 * This is **hand-written on purpose** and is the only hand-written file in the
 * golden tree. Generating it would mean running the whole entity pipeline
 * inside a unit test; the relationship smoke already proves the emitter agrees
 * with the real generated barrel, by type-checking the emitted model against it
 * under the consumer tsconfig. What this file buys is that the emitted artifact
 * becomes IMPORTABLE, so `test/integration/semantic-fanout.drizzle.integration.test.ts`
 * executes the real thing instead of a paraphrase of it.
 *
 * `src/__tests__/emitters/semantic/golden-schema.test.ts` pins that every table
 * the snapshot references exists here, and that the columns the model's
 * analytics tags name are real — so the two cannot drift apart silently.
 *
 * Table and column names mirror `entities/*.yaml` and the junction template's
 * output: entity tables are exported under `entity.plural` verbatim, a junction
 * under `camelCase(plural)` (SEM-2 Found #1).
 */

import { pgEnum, pgTable, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const accountTierEnum = pgEnum('account_tier', ['bronze', 'silver', 'gold']);
export const opportunityStageEnum = pgEnum('opportunity_stage', [
	'prospecting',
	'negotiation',
	'closed_won',
]);
export const opportunityContactRoleEnum = pgEnum('opportunity_contact_role', [
	'champion',
	'decision_maker',
	'influencer',
	'blocker',
	'end_user',
]);

export const accounts = pgTable('accounts', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	tenantId: uuid('tenant_id').notNull(),
	annualRevenue: numeric('annual_revenue'),
	healthScore: numeric('health_score'),
	tier: accountTierEnum('tier'),
	website: text('website'),
	externalId: text('external_id'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const contacts = pgTable('contacts', {
	id: uuid('id').primaryKey().defaultRandom(),
	firstName: text('first_name'),
	lastName: text('last_name'),
	email: text('email'),
	accountId: uuid('account_id').notNull(),
	primaryForAccountId: uuid('primary_for_account_id'),
	tags: text('tags').array(),
	linkedToEntityType: text('linked_to_entity_type'),
	linkedToEntityId: uuid('linked_to_entity_id'),
});

export const opportunities = pgTable('opportunities', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	amount: numeric('amount'),
	wonAmount: numeric('won_amount'),
	winProbability: numeric('win_probability'),
	stage: opportunityStageEnum('stage'),
	closedAt: timestamp('closed_at'),
	accountId: uuid('account_id').notNull(),
});

export const opportunityContacts = pgTable('opportunity_contacts', {
	id: uuid('id').primaryKey().defaultRandom(),
	opportunityId: uuid('opportunity_id').notNull(),
	contactId: uuid('contact_id').notNull(),
	role: opportunityContactRoleEnum('role').notNull(),
});
