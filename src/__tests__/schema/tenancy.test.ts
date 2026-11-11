/**
 * #791 — `resolveTenancy`, the one rule for which column a `tenant_scoped`
 * entity is scoped on and whether codegen emits or adopts it.
 */
import { describe, expect, it } from 'bun:test';

import { CodegenConfigSchema } from '../../schema/codegen-config.schema';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { resolveTenancy, tenantColumnName } from '../../schema/tenancy';

describe('resolveTenancy (#791)', () => {
	it('is null when the entity is not tenant_scoped', () => {
		expect(resolveTenancy('note', {}, 'tenant_id')).toBeNull();
		expect(resolveTenancy('note', { tenant_scoped: false }, 'tenant_id')).toBeNull();
	});

	it('emits the project tenant_id column when nothing adopts it', () => {
		expect(resolveTenancy('note', { tenant_scoped: true }, 'tenant_id')).toEqual({
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
			resolveTenancy(
				'deal',
				{
					tenant_scoped: { column: 'organization_id' },
					fields: { organization_id: { type: 'uuid' } },
					relationships: {
						organization: { type: 'belongs_to', foreign_key: 'organization_id' },
					},
				},
				'tenant_id',
			),
		).toEqual({
			column: 'organization_id',
			prop: 'organizationId',
			adopted: { kind: 'belongs_to', relationship: 'organization' },
		});
	});

	it('refuses to adopt a non-uuid field, naming the entity and field', () => {
		expect(() =>
			resolveTenancy(
				'deal',
				{
					tenant_scoped: { column: 'org_slug' },
					fields: { org_slug: { type: 'string' } },
				},
				'tenant_id',
			),
		).toThrow(/'deal': tenant_scoped adopts the field 'org_slug', but it is type: string/);
	});
});

describe('resolveTenancy refuses a column the table already declares (#791 N2)', () => {
	it("refuses 'id', naming the entity and the column", () => {
		expect(() => resolveTenancy('deal', { tenant_scoped: { column: 'id' } })).toThrow(
			/'deal': the tenant column 'id' collides with the primary key 'id'/,
		);
	});

	it('refuses a column the timestamps behavior emits', () => {
		for (const column of ['created_at', 'updated_at']) {
			expect(() =>
				resolveTenancy('deal', { tenant_scoped: { column }, behaviors: ['timestamps'] }),
			).toThrow(new RegExp(`'deal': the tenant column '${column}' collides with the '${column}' column of the 'timestamps' behavior`));
		}
	});

	it('reads a behavior declared with options, and every behavior the registry has', () => {
		expect(() =>
			resolveTenancy('deal', {
				tenant_scoped: { column: 'deleted_at' },
				behaviors: [{ name: 'soft_delete', options: {} }],
			}),
		).toThrow(/'deleted_at' column of the 'soft_delete' behavior/);
		expect(() =>
			resolveTenancy('deal', { tenant_scoped: { column: 'created_by' }, behaviors: ['user_tracking'] }),
		).toThrow(/'created_by' column of the 'user_tracking' behavior/);
	});

	it('refuses the external-id columns, explicit or implied by pattern: Integrated', () => {
		for (const column of ['provider', 'external_id', 'provider_metadata']) {
			expect(() =>
				resolveTenancy('lead', {
					tenant_scoped: { column },
					behaviors: ['external_id_tracking'],
				}),
			).toThrow(new RegExp(`'${column}' column of the 'external_id_tracking' behavior`));
		}
		expect(() =>
			resolveTenancy('lead', {
				entity: { pattern: 'Integrated' },
				tenant_scoped: { column: 'provider' },
			}),
		).toThrow(/'provider' column of the 'external_id_tracking' behavior \(implied by pattern: Integrated\)/);
	});

	it('allows the same column when no behavior emits it', () => {
		expect(resolveTenancy('deal', { tenant_scoped: { column: 'created_at' } })?.column).toBe('created_at');
	});
});

describe('tenantColumnName — the name without the adoption rule (#791 N4)', () => {
	it('is null when not tenant_scoped; entity, then project, then the default otherwise', () => {
		expect(tenantColumnName(false, 'workspace_id')).toBeNull();
		expect(tenantColumnName(true)).toBe('tenant_id');
		expect(tenantColumnName(true, 'workspace_id')).toBe('workspace_id');
		expect(tenantColumnName({ column: 'team_id' }, 'workspace_id')).toBe('team_id');
	});

	it('agrees with resolveTenancy', () => {
		const decl = { column: 'team_id' };
		expect(resolveTenancy('x', { tenant_scoped: decl }, 'workspace_id')?.column).toBe(
			tenantColumnName(decl, 'workspace_id'),
		);
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
