/**
 * #791 — a REL-2 hop into an entity scoped on a column OTHER than `tenant_id`
 * filters on that column, in both places RQBv2 traverses a relation: the `with:`
 * lateral and the `where: { <relation>: … }` EXISTS subquery.
 *
 * The schema is the adopted-column shape (an existing database keyed by
 * `organization_id`); the scope constants are exactly what `emit-manifest.ts`
 * renders for it. `.toSQL()` never connects, so this needs no Docker.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { defineRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { hopScope, type ScopeConfig } from '../../../../runtime/base-classes/scope-filters';
import { withRequester } from '../../../../runtime/base-classes/tenant-context';

const deals = pgTable('deals', {
	id: uuid('id').primaryKey().defaultRandom(),
	organizationId: uuid('organization_id').notNull(),
	name: text('name').notNull(),
});

const notes = pgTable('notes', {
	id: uuid('id').primaryKey().defaultRandom(),
	organizationId: uuid('organization_id').notNull(),
	dealId: uuid('deal_id').notNull(),
	body: text('body').notNull(),
});

const schema = { deals, notes };

const DEALS_SCOPE: ScopeConfig = { tenantScoped: true, tenantColumn: 'organizationId', softDelete: false, userTracking: false, enforcement: 'strict' };
const NOTES_SCOPE: ScopeConfig = { tenantScoped: true, tenantColumn: 'organizationId', softDelete: false, userTracking: false, enforcement: 'strict' };
// A manifest naming the wrong column: `tenantId` on a table that has no `tenant_id`.
const NOTES_SCOPE_DEFAULT: ScopeConfig = { tenantScoped: true, tenantColumn: 'tenantId', softDelete: false, userTracking: false, enforcement: 'strict' };

const relations = defineRelations(schema, (r) => ({
	deals: {
		notes: r.many.notes({
			from: r.deals.id,
			to: r.notes.dealId,
			where: { RAW: (t) => hopScope(t, NOTES_SCOPE, 'deals.notes') },
		}),
		notesUnconfigured: r.many.notes({
			from: r.deals.id,
			to: r.notes.dealId,
			where: { RAW: (t) => hopScope(t, NOTES_SCOPE_DEFAULT, 'deals.notesUnconfigured') },
		}),
	},
	notes: {
		deal: r.one.deals({
			from: r.notes.dealId,
			to: r.deals.id,
			optional: false,
			where: { RAW: (t) => hopScope(t, DEALS_SCOPE, 'notes.deal') },
		}),
	},
}));

let db: NodePgDatabase<typeof relations>;

beforeAll(() => {
	db = drizzle({ connection: 'postgresql://unused:unused@127.0.0.1:1/unused', relations });
});

const AS_ORG1 = { userId: 'u1', organizationId: 'ORG1', tenantId: 'ORG1' } as const;

describe('#791 — the hop predicate filters on the configured tenant column', () => {
	it('an include lateral filters on organization_id, never tenant_id', async () => {
		await withRequester(AS_ORG1, async () => {
			const { sql, params } = db.query.deals.findMany({ with: { notes: true } }).toSQL();
			expect(sql).toMatch(/"d1"\."organization_id" = \$\d+/);
			expect(sql).not.toContain('tenant_id');
			expect(params).toContain('ORG1');
		});
	});

	it('the to-one hop does too', async () => {
		await withRequester(AS_ORG1, async () => {
			const { sql } = db.query.notes.findMany({ with: { deal: true } }).toSQL();
			expect(sql).toMatch(/"d1"\."organization_id" = \$\d+/);
		});
	});

	it('the EXISTS form (`where: { <relation>: … }`) carries it as well', async () => {
		await withRequester(AS_ORG1, async () => {
			const { sql, params } = db.query.deals
				.findMany({ where: { notes: { body: { like: 'leak-%' } } } })
				.toSQL();
			expect(sql).toContain('exists (select * from "notes" as "f0"');
			expect(sql).toMatch(/"f0"\."organization_id" = \$\d+/);
			expect(params).toContain('ORG1');
		});
	});

	it('a scope constant missing its tenantColumn fails loud, naming the relation', async () => {
		await withRequester(AS_ORG1, async () => {
			expect(() =>
				db.query.deals.findMany({ with: { notesUnconfigured: true } }).toSQL(),
			).toThrow(/deals\.notesUnconfigured/);
		});
	});
});
