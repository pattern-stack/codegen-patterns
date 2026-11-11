/**
 * #791 — `resolveTenancy`, the one rule for which column a `tenant_scoped`
 * entity is scoped on and whether codegen emits or adopts it.
 */
import { describe, expect, it } from 'bun:test';

import { CodegenConfigSchema } from '../../schema/codegen-config.schema';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { resolveTenancy } from '../../schema/tenancy';

describe('resolveTenancy (#791)', () => {
	it('is null when the entity is not tenant_scoped', () => {
		expect(resolveTenancy('note', {})).toBeNull();
		expect(resolveTenancy('note', { tenant_scoped: false })).toBeNull();
	});

	it('defaults to an emitted tenant_id', () => {
		expect(resolveTenancy('note', { tenant_scoped: true })).toEqual({
			column: 'tenant_id',
			prop: 'tenantId',
			adopted: null,
		});
	});

	it('takes the project default, and the entity override over it', () => {
		expect(resolveTenancy('note', { tenant_scoped: true }, 'workspace_id')).toEqual({
			column: 'workspace_id',
			prop: 'workspaceId',
			adopted: null,
		});
		expect(
			resolveTenancy('note', { tenant_scoped: { column: 'team_id' } }, 'workspace_id'),
		).toEqual({ column: 'team_id', prop: 'teamId', adopted: null });
	});

	it('adopts a declared uuid field of that name', () => {
		expect(
			resolveTenancy(
				'deal',
				{ tenant_scoped: true, fields: { organization_id: { type: 'uuid' } } },
				'organization_id',
			),
		).toEqual({ column: 'organization_id', prop: 'organizationId', adopted: { kind: 'field' } });
	});

	it('adopts a belongs_to whose foreign key is the column (ahead of a field of that name)', () => {
		expect(
			resolveTenancy('deal', {
				tenant_scoped: { column: 'organization_id' },
				fields: { organization_id: { type: 'uuid' } },
				relationships: {
					organization: { type: 'belongs_to', foreign_key: 'organization_id' },
				},
			}),
		).toEqual({
			column: 'organization_id',
			prop: 'organizationId',
			adopted: { kind: 'belongs_to', relationship: 'organization' },
		});
	});

	it('refuses to adopt a non-uuid field, naming the entity and field', () => {
		expect(() =>
			resolveTenancy('deal', {
				tenant_scoped: { column: 'org_slug' },
				fields: { org_slug: { type: 'string' } },
			}),
		).toThrow(/'deal': tenant_scoped adopts the field 'org_slug', but it is type: string/);
	});
});

describe('the tenancy YAML surface (#791)', () => {
	it('codegen.config.yaml `tenancy.column` defaults to tenant_id and is strict', () => {
		expect(CodegenConfigSchema.parse({}).tenancy).toEqual({ column: 'tenant_id' });
		expect(CodegenConfigSchema.parse({ tenancy: { column: 'organization_id' } }).tenancy).toEqual({
			column: 'organization_id',
		});
		expect(() => CodegenConfigSchema.parse({ tenancy: { column: 'OrgId' } })).toThrow();
		expect(() => CodegenConfigSchema.parse({ tenancy: { colum: 'org_id' } })).toThrow();
	});

	it('entity `tenant_scoped:` takes true or { column }', () => {
		const base = { entity: { name: 'deal', plural: 'deals', table: 'deals' }, fields: {} };
		expect(EntityDefinitionSchema.safeParse({ ...base, tenant_scoped: true }).success).toBe(true);
		expect(
			EntityDefinitionSchema.safeParse({ ...base, tenant_scoped: { column: 'organization_id' } })
				.success,
		).toBe(true);
		expect(
			EntityDefinitionSchema.safeParse({ ...base, tenant_scoped: { column: 'Org' } }).success,
		).toBe(false);
		expect(
			EntityDefinitionSchema.safeParse({ ...base, tenant_scoped: { references: 'orgs' } }).success,
		).toBe(false);
	});
});
