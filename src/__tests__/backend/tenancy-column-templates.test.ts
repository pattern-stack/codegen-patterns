/**
 * #791 — a configurable tenancy column. `tenant_scoped` scopes on `tenant_id`
 * unless the project's `tenancy.column` or the entity's `tenant_scoped:
 * { column }` names another, and a column the entity already declares (a field,
 * or a `belongs_to` foreign key) is ADOPTED rather than emitted twice.
 *
 * The default (`tenant_id`, emitted) is pinned by `tenant-scoping-templates.test.ts`
 * and the baseline snapshots, which this change leaves byte-identical. This file
 * covers the two new shapes: a custom EMITTED column, and an ADOPTED one.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { buildSinkInput } from '../../cli/shared/adapter-emission-generator';
import { withEntities } from './_entity-lookup';

function template(rel: string): string {
	const source = readFileSync(
		resolve(import.meta.dir, '../../../templates/entity/new/backend', rel),
		'utf8',
	);
	const lines = source.split('\n');
	const end = lines.indexOf('---', 1);
	return lines.slice(end + 1).join('\n');
}

const render = (rel: string) => (locals: Record<string, unknown>) =>
	ejs.render(template(rel), locals, { rmWhitespace: false });
const renderEntity = render('entity.ejs.t');
const renderRepository = render('repository.ejs.t');
const renderCreateDto = render('dto/create.ejs.t');
const renderOutputDto = render('dto/output.ejs.t');

const localsFor = (def: Record<string, unknown>, base: Record<string, unknown> = {}) =>
	buildBackendLocals(def, withEntities(base));

const deal = (extra: Record<string, unknown> = {}) => ({
	entity: { name: 'deal', plural: 'deals', table: 'deals', pattern: 'Base' },
	fields: {
		name: { type: 'string', required: true },
		slug: { type: 'string', required: true, unique: true },
	},
	relationships: {},
	behaviors: ['timestamps'],
	tenant_scoped: true,
	...extra,
});

// ============================================================================
// A custom EMITTED column
// ============================================================================

describe('#791 — a custom emitted tenant column', () => {
	const projectDefault = () => localsFor(deal(), { tenancyColumn: 'workspace_id' });

	it('the project default names the column, index and unique prefix', () => {
		const out = renderEntity(projectDefault());
		expect(out).toContain("workspaceId: uuid('workspace_id'),");
		expect(out).not.toContain('tenant_id');
		expect(out).not.toContain('tenantId');
		expect(out).toContain("index('deals_workspace_id_idx').on(t.workspaceId)");
		expect(out).toContain(
			"unique('deals_workspace_id_slug_uniq').on(t.workspaceId, t.slug).nullsNotDistinct()",
		);
	});

	it('the entity override wins over the project default', () => {
		const out = renderEntity(
			localsFor(deal({ tenant_scoped: { column: 'team_id' } }), { tenancyColumn: 'workspace_id' }),
		);
		expect(out).toContain("teamId: uuid('team_id'),");
		expect(out).not.toContain('workspace');
	});

	it('the BehaviorConfig names the column key; the default stays unwritten', () => {
		const out = renderRepository(projectDefault());
		expect(out).toContain("    tenantScoped: true,\n    tenantColumn: 'workspaceId',\n  };");
		expect(out).toContain("protected override readonly scopeEnforcement = 'strict' as const;");

		const dflt = renderRepository(localsFor(deal()));
		expect(dflt).not.toContain('tenantColumn');
	});

	it('the tenant column is listed once in a unique entry it is prefixed onto — listing it is C2', () => {
		expect(() =>
			localsFor(deal({ unique_indexes: [{ fields: ['workspace_id', 'name'] }] }), {
				tenancyColumn: 'workspace_id',
			}),
		).toThrow(/'workspace_id' must not be listed in fields — it is the tenant column/);
	});

	it('external_id_tracking: the per-tenant constraint and the conflict target use the column', () => {
		const def = deal({
			entity: { name: 'lead', plural: 'leads', table: 'leads', pattern: 'Integrated' },
			fields: { name: { type: 'string', required: true } },
			behaviors: ['timestamps', 'external_id_tracking'],
		});
		const locals = localsFor(def, { tenancyColumn: 'workspace_id' });
		expect(renderEntity(locals)).toContain(
			"unique('uq_leads_tenant_provider_external_id')" +
				'.on(t.workspaceId, t.provider, t.externalId).nullsNotDistinct()',
		);
		expect(renderRepository(locals)).toContain(
			"conflictTarget: ['workspaceId', 'provider', 'externalId']",
		);
	});
});

// ============================================================================
// An ADOPTED column — the existing-schema case (a host keyed by organization_id)
// ============================================================================

describe('#791 — adopting a declared field', () => {
	const adopted = (extra: Record<string, unknown> = {}) =>
		deal({
			tenant_scoped: { column: 'organization_id' },
			fields: {
				name: { type: 'string', required: true },
				organization_id: { type: 'uuid', required: true, index: true },
			},
			...extra,
		});

	it('emits the field once, with its own nullability, and indexes it once', () => {
		const out = renderEntity(localsFor(adopted()));
		expect(out.match(/organizationId:/g)).toHaveLength(1);
		expect(out).toContain("organizationId: uuid('organization_id').notNull(),");
		expect(out.match(/deals_organization_id_idx/g)).toHaveLength(1);
		expect(out).toContain("index('deals_organization_id_idx').on(t.organizationId)");
		expect(out).not.toContain('tenant_id');
	});

	it('leaves the create (and so update) DTO; the output DTO keeps it', () => {
		const locals = localsFor(adopted());
		expect(renderCreateDto(locals)).not.toContain('organizationId');
		expect(renderCreateDto(locals)).toContain('name:');
		expect(renderOutputDto(locals)).toContain('organizationId:');
	});

	it('the BehaviorConfig names it', () => {
		expect(renderRepository(localsFor(adopted()))).toContain("tenantColumn: 'organizationId',");
	});

	it('#715: a field named tenant_id under the default is adopted, not duplicated (no TS1117)', () => {
		const out = renderEntity(
			localsFor(
				deal({
					fields: {
						name: { type: 'string', required: true },
						tenant_id: { type: 'uuid', required: true },
					},
				}),
			),
		);
		expect(out.match(/tenantId:/g)).toHaveLength(1);
		expect(out).toContain("tenantId: uuid('tenant_id').notNull(),");
		expect(renderRepository(localsFor(deal({ fields: { tenant_id: { type: 'uuid' } } })))).not.toContain(
			'tenantColumn',
		);
	});

	it('an Integrated entity keeps the adopted column off its upsert write surface', () => {
		const def = adopted({
			entity: { name: 'lead', plural: 'leads', table: 'leads', pattern: 'Integrated' },
			behaviors: ['timestamps', 'external_id_tracking'],
		});
		const locals = localsFor(def) as {
			integrationConfig: { conflictTarget: string[]; writeColumns: string[]; projectionColumns: string[] };
			integrationWriteFields: Array<{ camelName: string }>;
		};
		expect(locals.integrationConfig.conflictTarget).toEqual(['organizationId', 'provider', 'externalId']);
		expect(locals.integrationConfig.writeColumns).not.toContain('organizationId');
		expect(locals.integrationWriteFields.map((f) => f.camelName)).not.toContain('organizationId');
		expect(locals.integrationConfig.projectionColumns).toContain('organizationId');

		// …and so does the sink, the mirror derivation in the adapter emitter.
		const sink = buildSinkInput(
			def as Parameters<typeof buildSinkInput>[0],
			'crm',
			'hubspot',
			'../repo',
		);
		expect(sink.copyThroughFields.map((f) => f.camelName)).not.toContain('organizationId');
		expect(sink.viewCopyThroughFields.map((f) => f.camelName)).toContain('organizationId');
	});
});

describe('#791 — adopting a belongs_to foreign key', () => {
	const member = () => ({
		entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Base' },
		fields: { email: { type: 'string', required: true } },
		relationships: {
			account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id', required: true },
		},
		behaviors: [],
		tenant_scoped: { column: 'account_id' },
	});

	it('emits the FK column once (with its .references()) and no tenant block column', () => {
		const out = renderEntity(localsFor(member()));
		expect(out.match(/accountId:/g)).toHaveLength(1);
		expect(out).toContain("accountId: uuid('account_id')");
		expect(out).toContain('.references((): AnyPgColumn => accounts.id');
		expect(out).toContain("index('contacts_account_id_idx').on(t.accountId)");
	});

	it('drops the FK from the create DTO and keeps it on the output DTO', () => {
		const locals = localsFor(member());
		expect(renderCreateDto(locals)).not.toContain('accountId');
		expect(renderOutputDto(locals)).toContain('accountId:');
		expect(renderRepository(locals)).toContain("tenantColumn: 'accountId',");
	});

	it('refuses to adopt a non-uuid field', () => {
		expect(() =>
			localsFor(
				deal({
					tenant_scoped: { column: 'org_slug' },
					fields: { org_slug: { type: 'string' } },
				}),
			),
		).toThrow(/tenant_scoped adopts the field 'org_slug', but it is type: string/);
	});
});
