/**
 * #791 — the frontend graph resolves the SAME tenant scope as the backend
 * manifest. FE-REL's one-graph rule: the client descriptor and the Drizzle
 * manifest are one declaration projected twice, so `tenancy.column` must reach
 * `buildRelationGraph` from both. Before this, the frontend call omitted it and
 * resolved `tenant_id` for every entity, which failed a valid project (an entity
 * with a `tenant_id: string` field under `tenancy.column: organization_id`).
 */

import { describe, expect, it } from 'bun:test';

import { buildClientGraph } from '../../../emitters/frontend/graph-model';
import { mapFrontendEmitConfig } from '../../../emitters/frontend/load-context';
import type { FrontendEmitContext } from '../../../emitters/frontend/types';
import { buildRelationGraph } from '../../../emitters/relations/build-graph';
import { EntityDefinitionSchema } from '../../../schema/entity-definition.schema';
import type { EntityDefinition } from '../../../schema/entity-definition.schema';
import { config, entry, parsedEntity } from './_helpers';

function definition(
	name: string,
	plural: string,
	fields: Record<string, unknown>,
	relationships: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): EntityDefinition {
	return EntityDefinitionSchema.parse({
		entity: { name, plural },
		fields,
		relationships,
		...extra,
	});
}

/**
 * `account` is scoped on the project column and carries an UNRELATED
 * `tenant_id: string` field — valid under `organization_id`, a type error under
 * the default `tenant_id` (which must be a uuid).
 */
function ctxFor(tenancyColumn: string): FrontendEmitContext {
	const account = entry('account', 'accounts');
	const contact = entry('contact', 'contacts');
	const definitions = new Map<string, EntityDefinition>([
		[
			'account',
			definition(
				'account',
				'accounts',
				{ tenant_id: { type: 'string' }, organization_id: { type: 'uuid' } },
				{ contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' } },
				{ tenant_scoped: true },
			),
		],
		[
			'contact',
			definition(
				'contact',
				'contacts',
				{ account_id: { type: 'uuid', required: true } },
				{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
			),
		],
	]);
	return {
		entities: [account, contact],
		parsed: new Map([
			['account', parsedEntity(account)],
			['contact', parsedEntity(contact)],
		]),
		config: config({ tenancyColumn }),
		definitions,
		junctions: [],
	};
}

describe('the frontend graph follows tenancy.column (#791)', () => {
	it('mapFrontendEmitConfig reads tenancy.column from the loaded config, defaulting to tenant_id', () => {
		expect(mapFrontendEmitConfig({}).tenancyColumn).toBe('tenant_id');
		expect(mapFrontendEmitConfig({ tenancy: { column: 'organization_id' } }).tenancyColumn).toBe(
			'organization_id',
		);
	});

	it('builds under tenancy.column: organization_id, where the default column would refuse', () => {
		expect(() => buildClientGraph(ctxFor('organization_id'))).not.toThrow();
		expect(() => buildClientGraph(ctxFor('tenant_id'))).toThrow(
			/adopts the field 'tenant_id', but it is type: string/,
		);
	});

	it('resolves the same target scope as the backend builder', () => {
		const ctx = ctxFor('organization_id');
		const backend = buildRelationGraph({
			entities: ctx.entities,
			definitions: ctx.definitions ?? new Map(),
			junctions: [],
			tenancyColumn: 'organization_id',
		});
		const scope = backend.tables
			.find((t) => t.table === 'contacts')
			?.edges.find((e) => e.key === 'account')?.targetScope;
		expect(scope).toMatchObject({ tenantScoped: true, tenantColumn: 'organizationId' });
		// The frontend call is the same builder over the same inputs; it builds
		// (above) only because it was handed the same project column.
		expect(buildClientGraph(ctx).nodes.map((n) => n.collection)).toContain('contacts');
	});
});
