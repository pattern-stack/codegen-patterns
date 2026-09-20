/**
 * The per-hop predicate, as SQL — REL-2 §1.1/§1.2/§1.3/§1.4 (#587).
 *
 * These are the spike's measurements, promoted to permanent gates now that the
 * code they measured exists. Every one renders a statement with `.toSQL()`
 * against a manifest built exactly the way `src/emitters/relations` emits one, so
 * a change in Drizzle's traversal — or a regression in `hopScope` — turns them red
 * without needing Docker.
 *
 * The one that matters most is §1.4: RQBv2 traverses a relation in TWO places,
 * the `with:` lateral AND the `where: { <relation>: … }` EXISTS subquery. A
 * repository that rewrote the caller's include tree would scope the first and
 * miss the second, which is an existence oracle over other tenants' rows. With
 * the predicate on the relation, both carry it.
 *
 * Row-level proof lives in `test/scaffold/tests/relation-scope.test.ts`
 * (`just test-integration`); this file proves the SQL.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { defineRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
	hopScope,
	type ScopeConfig,
} from '../../../../runtime/base-classes/scope-filters';
import { withRequester } from '../../../../runtime/base-classes/tenant-context';

// ── the schema, as the entity templates emit one ───────────────────────────
const accounts = pgTable('accounts', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	deletedAt: timestamp('deleted_at'),
	name: text('name').notNull(),
	parentAccountId: uuid('parent_account_id'),
});

const contacts = pgTable('contacts', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	deletedAt: timestamp('deleted_at'),
	accountId: uuid('account_id').notNull(),
	email: text('email').notNull(),
});

const opportunities = pgTable('opportunities', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	deletedAt: timestamp('deleted_at'),
	accountId: uuid('account_id').notNull(),
	name: text('name').notNull(),
});

const opportunityContacts = pgTable('opportunity_contacts', {
	opportunityId: uuid('opportunity_id').notNull(),
	contactId: uuid('contact_id').notNull(),
	role: text('role'),
});

const schema = { accounts, contacts, opportunities, opportunityContacts };

// ── the scope constants, exactly as `emit-manifest.ts` renders them ────────
const ACCOUNTS_SCOPE: ScopeConfig = {
	tenantScoped: true,
	softDelete: true,
	userTracking: false,
	enforcement: 'strict',
};
const CONTACTS_SCOPE: ScopeConfig = {
	tenantScoped: true,
	softDelete: true,
	userTracking: false,
	enforcement: 'strict',
};
const OPPORTUNITIES_SCOPE: ScopeConfig = {
	tenantScoped: true,
	softDelete: true,
	userTracking: false,
	enforcement: 'strict',
};

const relations = defineRelations(schema, (r) => ({
	accounts: {
		contacts: r.many.contacts({
			from: r.accounts.id,
			to: r.contacts.accountId,
			where: { RAW: (t) => hopScope(t, CONTACTS_SCOPE, 'accounts.contacts') },
		}),
		opportunities: r.many.opportunities({
			from: r.accounts.id,
			to: r.opportunities.accountId,
			where: { RAW: (t) => hopScope(t, OPPORTUNITIES_SCOPE, 'accounts.opportunities') },
		}),
		parentAccount: r.one.accounts({
			from: r.accounts.parentAccountId,
			to: r.accounts.id,
			optional: true,
			where: { RAW: (t) => hopScope(t, ACCOUNTS_SCOPE, 'accounts.parentAccount') },
		}),
	},
	contacts: {
		account: r.one.accounts({
			from: r.contacts.accountId,
			to: r.accounts.id,
			optional: false,
			where: { RAW: (t) => hopScope(t, ACCOUNTS_SCOPE, 'contacts.account') },
		}),
		opportunities: r.many.opportunities({
			from: r.contacts.id.through(r.opportunityContacts.contactId),
			to: r.opportunities.id.through(r.opportunityContacts.opportunityId),
			where: { RAW: (t) => hopScope(t, OPPORTUNITIES_SCOPE, 'contacts.opportunities') },
		}),
	},
	opportunities: {
		contacts: r.many.contacts({
			from: r.opportunities.id.through(r.opportunityContacts.opportunityId),
			to: r.contacts.id.through(r.opportunityContacts.contactId),
			where: { RAW: (t) => hopScope(t, CONTACTS_SCOPE, 'opportunities.contacts') },
		}),
	},
	opportunityContacts: {},
}));

let db: NodePgDatabase<typeof relations>;

beforeAll(() => {
	// `.toSQL()` never connects — no pool is opened and no query is sent.
	db = drizzle({
		connection: 'postgresql://unused:unused@127.0.0.1:1/unused',
		relations,
	});
});

const AS_T1 = { userId: 'u1', organizationId: null, tenantId: 'T1' } as const;

describe('REL-2 §1.1 — an include renders one statement, scoped at every hop', () => {
	it('each traversed relation contributes its own predicate to its lateral', async () => {
		await withRequester(AS_T1, async () => {
			const { sql, params } = db.query.accounts
				.findMany({
					with: {
						parentAccount: true,
						contacts: { with: { opportunities: true } },
					},
				})
				.toSQL();

			// One statement. Three laterals, three predicates.
			expect(sql.split('select').length - 1).toBeGreaterThan(1);
			expect(sql).toContain('"accounts" as "d1"');
			expect(sql).toContain('"contacts" as "d1"');
			expect(sql).toContain('"opportunities" as "d2"');
			for (const table of ['d1', 'd2']) {
				expect(sql).toContain(`"${table}"."deleted_at" is null`);
			}
			// Every hop bound the SAME ambient tenant, resolved per hop at build time.
			expect(params.filter((p) => p === 'T1').length).toBe(3);
		});
	});

	it('a `.through()` hop scopes the TARGET table (the junction carries only the join)', async () => {
		await withRequester(AS_T1, async () => {
			const { sql } = db.query.opportunities
				.findMany({ with: { contacts: true } })
				.toSQL();

			expect(sql).toContain('inner join "opportunity_contacts"');
			// The predicate is on the far side, not on the junction row.
			expect(sql).toMatch(/"d1"\."tenant_id" = \$\d+/);
			expect(sql).not.toMatch(/"tr1"\."tenant_id"/);
		});
	});
});

describe('REL-2 §1.2 — the predicate is per-REQUEST, not frozen at import', () => {
	it('the same query built under a different tenant binds a different value', async () => {
		const asT1 = await withRequester(AS_T1, async () =>
			db.query.accounts.findMany({ with: { contacts: true } }).toSQL(),
		);
		const asT2 = await withRequester({ ...AS_T1, tenantId: 'T2' }, async () =>
			db.query.accounts.findMany({ with: { contacts: true } }).toSQL(),
		);

		expect(asT1.sql).toBe(asT2.sql);
		expect(asT1.params).toContain('T1');
		expect(asT2.params).toContain('T2');
		expect(asT2.params).not.toContain('T1');
	});

	it('a query with NO include never invokes a hop predicate', () => {
		// No ambient context at all, and the configs are `strict` — so if a hop
		// predicate ran, this would throw. Root-only reads are untouched.
		expect(() => db.query.accounts.findMany({}).toSQL()).not.toThrow();
	});

	it('a traversing query with no ambient context throws BEFORE any SQL is built', () => {
		expect(() =>
			db.query.accounts.findMany({ with: { contacts: true } }).toSQL(),
		).toThrow(/No requester context active/);
	});
});

describe('REL-2 §1.3 — a caller filter composes with the hop predicate', () => {
	it('AND-s the caller condition; it cannot widen the scope', async () => {
		await withRequester(AS_T1, async () => {
			const { sql, params } = db.query.accounts
				.findMany({
					with: {
						contacts: {
							where: { email: { like: '%@example.com' } },
							orderBy: { email: 'asc' },
							limit: 5,
						},
					},
				})
				.toSQL();

			expect(sql).toContain('"d1"."email" like');
			expect(sql).toContain('"d1"."deleted_at" is null');
			expect(sql).toMatch(/"d1"\."tenant_id" = \$\d+/);
			expect(sql).toContain('order by "d1"."email" asc');
			expect(params).toContain('%@example.com');
			expect(params).toContain('T1');
		});
	});
});

describe('REL-2 §1.4 — the relational-filter form is scoped too (the finding)', () => {
	it('`where: { <relation>: … }` with NO `with:` still carries the predicate', async () => {
		await withRequester(AS_T1, async () => {
			const { sql, params } = db.query.accounts
				.findMany({ where: { contacts: { email: { like: 'leak-%' } } } })
				.toSQL();

			// An EXISTS subquery, not a lateral — the traversal an include-tree
			// rewriter never sees, because there is no `with` to rewrite.
			expect(sql).toContain('exists (select * from "contacts" as "f0"');
			expect(sql).toContain('"f0"."deleted_at" is null');
			expect(sql).toMatch(/"f0"\."tenant_id" = \$\d+/);
			expect(params).toContain('T1');
			expect(params).toContain('leak-%');
		});
	});

	it('the EXISTS form also fails closed with no ambient context', () => {
		expect(() =>
			db.query.accounts
				.findMany({ where: { contacts: { email: { like: 'leak-%' } } } })
				.toSQL(),
		).toThrow(/No requester context active/);
	});
});
