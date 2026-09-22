/**
 * `scope-filters.ts` — the scope predicate for ONE table (REL-2 §3, #587).
 *
 * The rule under test is charter I3: the root and every hop of an include tree
 * carry the SAME guards, built by the same function. These tests pin the function
 * itself; `hop-scope-sql.spec.ts` pins the SQL it renders inside a real relations
 * manifest, and `test/scaffold/tests/relation-scope.test.ts` pins the rows.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
	hopScope,
	isUnscoped,
	scopeFilter,
	tenantPredicateFor,
	userScopePredicateFor,
	type ScopeConfig,
} from '../../../../runtime/base-classes/scope-filters';
import {
	MissingTenantIdError,
	withAllTenants,
	withOrgScope,
	withRequester,
	withSuperuserScope,
	withTenantScope,
} from '../../../../runtime/base-classes/tenant-context';

const widgets = pgTable('widgets', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id'),
	userId: uuid('user_id'),
	deletedAt: timestamp('deleted_at'),
	name: text('name').notNull(),
});

/** A table with none of the scope columns — the throw-on-missing-column case. */
const bare = pgTable('bare', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
});

const cfg = (over: Partial<ScopeConfig> = {}): ScopeConfig => ({
	tenantScoped: false,
	softDelete: false,
	userTracking: false,
	enforcement: 'lenient',
	...over,
});

const dialect = new PgDialect();

/** Render a predicate to real SQL + bind params, driver-free. */
function render(predicate: ReturnType<typeof scopeFilter>): {
	sql: string;
	params: unknown[];
} {
	if (!predicate) throw new Error('expected a predicate');
	const query = dialect.sqlToQuery(predicate);
	return { sql: query.sql, params: query.params };
}

describe('isUnscoped', () => {
	it('is true only when no axis is declared', () => {
		expect(isUnscoped(cfg())).toBe(true);
		expect(isUnscoped(cfg({ softDelete: true }))).toBe(false);
		expect(isUnscoped(cfg({ userTracking: true }))).toBe(false);
		expect(isUnscoped(cfg({ tenantScoped: true }))).toBe(false);
	});

	it('ignores `enforcement` — it is a posture, not an axis', () => {
		expect(isUnscoped(cfg({ enforcement: 'strict' }))).toBe(true);
	});
});

describe('tenantPredicateFor', () => {
	it('an ABSENT tenant means "do not scope", not "match nothing"', () => {
		expect(tenantPredicateFor(widgets, undefined, 'T')).toBeUndefined();
	});

	it('an EXPLICIT null is the null-tenant partition — IS NULL, not a wildcard', () => {
		const p = tenantPredicateFor(widgets, null, 'T');
		expect(p).toBeDefined();
		expect(render(p).sql).toContain('is null');
	});

	it('a string is an equality on tenant_id', () => {
		const p = tenantPredicateFor(widgets, 'T1', 'T');
		expect(p).toBeDefined();
		expect(render(p).sql).toContain('tenant_id');
	});

	it('throws, naming the owner, when the table has no tenant_id', () => {
		expect(() => tenantPredicateFor(bare, 'T1', 'accounts.contacts')).toThrow(
			"accounts.contacts: table has no column 'tenantId'",
		);
	});
});

describe('userScopePredicateFor', () => {
	it('is undefined with no ambient context under lenient', () => {
		expect(userScopePredicateFor(widgets, 'lenient', 'T')).toBeUndefined();
	});

	it('throws with no ambient context under strict', () => {
		expect(() => userScopePredicateFor(widgets, 'strict', 'T')).toThrow(
			/No requester context active/,
		);
	});

	it("'superuser' drops the filter entirely", async () => {
		await withSuperuserScope('u1', async () => {
			expect(userScopePredicateFor(widgets, 'lenient', 'T')).toBeUndefined();
		});
	});

	it("'org' with an EMPTY member list matches nothing — fail-closed", async () => {
		await withRequester(
			{ userId: 'u1', organizationId: 'o1', scope: 'org', orgUserIds: [] },
			async () => {
				const p = userScopePredicateFor(widgets, 'lenient', 'T');
				expect(p).toBeDefined();
				expect(render(p).sql).toContain('false');
			},
		);
	});

	it("'org' with members filters by user_id IN (…)", async () => {
		await withOrgScope('u1', 'o1', ['u1', 'u2'], async () => {
			const p = userScopePredicateFor(widgets, 'lenient', 'T');
			expect(render(p).sql).toContain('user_id');
		});
	});
});

describe('scopeFilter', () => {
	it('is undefined when nothing is declared', () => {
		expect(scopeFilter(widgets, cfg(), 'T')).toBeUndefined();
	});

	it('is undefined for a declared-but-inert config (lenient, no context)', () => {
		expect(scopeFilter(widgets, cfg({ userTracking: true }), 'T')).toBeUndefined();
	});

	it('combines soft-delete, the user axis and the tenant axis in that order', async () => {
		await withRequester(
			{ userId: 'u1', organizationId: null, tenantId: 'T1' },
			async () => {
				const p = scopeFilter(
					widgets,
					cfg({ softDelete: true, userTracking: true, tenantScoped: true }),
					'T',
				);
				const text = render(p).sql;
				expect(text.indexOf('deleted_at')).toBeGreaterThanOrEqual(0);
				expect(text.indexOf('deleted_at')).toBeLessThan(text.indexOf('user_id'));
				expect(text.indexOf('user_id')).toBeLessThan(text.indexOf('tenant_id'));
			},
		);
	});

	it('a STRICT tenant-scoped config with a context but no tenant throws', async () => {
		await withRequester({ userId: 'u1', organizationId: null }, async () => {
			expect(() =>
				scopeFilter(widgets, cfg({ tenantScoped: true, enforcement: 'strict' }), 'accounts'),
			).toThrow(MissingTenantIdError);
		});
	});

	it('a STRICT tenant-scoped config with NO context at all throws', () => {
		expect(() =>
			scopeFilter(widgets, cfg({ tenantScoped: true, enforcement: 'strict' }), 'accounts'),
		).toThrow(/No requester context active/);
	});

	it('withTenantScope changes the tenant a hop reads, per call', async () => {
		await withRequester(
			{ userId: 'u1', organizationId: null, tenantId: 'T1' },
			async () => {
				const outer = scopeFilter(widgets, cfg({ tenantScoped: true }), 'T');
				await withTenantScope('T2', async () => {
					const inner = scopeFilter(widgets, cfg({ tenantScoped: true }), 'T');
					// Same shape, different bound value — the point of reading the ALS at
					// query-build time rather than at module load (REL-2 §1.2).
					expect(render(inner).sql).toBe(render(outer).sql);
					expect(inner).not.toBe(outer);
				});
			},
		);
	});

	it('withAllTenants drops the tenant predicate but keeps the others', async () => {
		await withRequester(
			{ userId: 'u1', organizationId: null, tenantId: 'T1' },
			async () => {
				await withAllTenants(async () => {
					const p = scopeFilter(
						widgets,
						cfg({ tenantScoped: true, softDelete: true }),
						'T',
					);
					const text = render(p).sql;
					expect(text).toContain('deleted_at');
					expect(text).not.toContain('tenant_id');
				});
			},
		);
	});
});

describe('hopScope', () => {
	it('renders `true` rather than nothing when a config resolves to no predicate', () => {
		// A relation `where` takes a SQL, not SQL | undefined. Returning nothing
		// would drop the relation's own join condition.
		const text = render(hopScope(widgets, cfg({ userTracking: true }), 'a.b')).sql;
		expect(text).toBe('true');
	});

	it('is the SAME predicate the root uses — not a second implementation', async () => {
		await withRequester(
			{ userId: 'u1', organizationId: null, tenantId: 'T1' },
			async () => {
				const config = cfg({ softDelete: true, tenantScoped: true });
				expect(render(hopScope(widgets, config, 'a.b')).sql).toBe(
					render(scopeFilter(widgets, config, 'a.b')).sql,
				);
			},
		);
	});

	it('names the relation when a scoped target has no tenant column', async () => {
		// Only reachable once a tenant is actually resolvable: with no ambient
		// context under `lenient` the predicate is skipped before the column is
		// touched, which is why this needs a context to surface the misdeclaration.
		await withRequester(
			{ userId: 'u1', organizationId: null, tenantId: 'T1' },
			async () => {
				expect(() =>
					hopScope(bare, cfg({ tenantScoped: true }), 'accounts.parentAccount'),
				).toThrow("accounts.parentAccount: table has no column 'tenantId'");
			},
		);
	});
});
