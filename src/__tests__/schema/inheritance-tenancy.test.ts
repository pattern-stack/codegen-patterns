/**
 * RFC-0006 §2.3 — a child's tenancy is its base's, derived in one place
 * (`src/schema/tenancy.ts`), and R10 / R5 live beside it.
 */

import { describe, expect, it } from 'bun:test';

import {
	baseTenantColumnIssue,
	lifecycleBehaviorsDeclared,
	resolveChildTenancy,
} from '../../schema/tenancy';
import { rawFixture } from '../parser/inheritance-family';

describe('resolveChildTenancy', () => {
	it('derives column, tenantScoped and strict enforcement from the base', () => {
		expect(resolveChildTenancy('communication', rawFixture('communication'), 'tenant_id')).toEqual({
			column: 'tenant_id',
			prop: 'tenantId',
			tenantScoped: true,
			scopeEnforcement: 'strict',
			base: 'communication',
		});
	});

	it("uses the base's own column name, not the project's", () => {
		const base = rawFixture('communication', (r) => {
			r.tenant_scoped = { column: 'org_id' };
			r.fields.org_id = { type: 'uuid', required: true };
			delete r.fields.tenant_id;
		});
		const tenancy = resolveChildTenancy('communication', base, 'tenant_id');
		expect(tenancy?.column).toBe('org_id');
		expect(tenancy?.prop).toBe('orgId');
	});

	it('is null when the base is not tenant_scoped', () => {
		const base = rawFixture('communication', (r) => delete r.tenant_scoped);
		expect(resolveChildTenancy('communication', base, 'tenant_id')).toBeNull();
	});
});

describe('baseTenantColumnIssue (R10)', () => {
	it('is null for a declared NOT NULL column', () => {
		expect(baseTenantColumnIssue('communication', rawFixture('communication'), 'tenant_id')).toBeNull();
	});
	it('names the base when the column would be emitted nullable', () => {
		const base = rawFixture('communication', (r) => delete r.fields.tenant_id);
		expect(baseTenantColumnIssue('communication', base, 'tenant_id')).toContain("'communication' is tenant_scoped");
	});
	it('names the base when the declared column is nullable', () => {
		const base = rawFixture('communication', (r) => (r.fields.tenant_id = { type: 'uuid', nullable: true }));
		expect(baseTenantColumnIssue('communication', base, 'tenant_id')).toContain("'communication' declares its tenant column");
	});
	it('is null for a base that is not tenant_scoped', () => {
		expect(baseTenantColumnIssue('x', rawFixture('party'), 'tenant_id')).toBeNull();
	});
});

describe('lifecycleBehaviorsDeclared (R5)', () => {
	it('is empty for a child that declares none', () => {
		expect(lifecycleBehaviorsDeclared(rawFixture('meeting'))).toEqual([]);
	});
	it('lists the base-only behaviors a def declares', () => {
		expect(lifecycleBehaviorsDeclared(rawFixture('communication'))).toEqual(['timestamps']);
		expect(lifecycleBehaviorsDeclared(rawFixture('communication_part'))).toEqual(['soft_delete']);
	});
	it('does not count a behavior Integrated implies: the base supplies its columns (S7)', () => {
		expect(lifecycleBehaviorsDeclared(rawFixture('meeting', (r) => (r.entity.pattern = 'Integrated')))).toEqual([]);
	});
	it('counts one the child DECLARES, with or without Integrated', () => {
		expect(
			lifecycleBehaviorsDeclared(
				rawFixture('meeting', (r) => {
					r.entity.pattern = 'Integrated';
					r.behaviors = ['external_id_tracking'];
				}),
			),
		).toEqual(['external_id_tracking']);
	});
});
