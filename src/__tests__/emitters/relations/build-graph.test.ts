/**
 * Relations emitter — graph construction unit tests (ADR-044, REL-1).
 *
 * The golden snapshot locks the whole emitted file; these lock the RULES, so a
 * regression names itself instead of showing up as a diff hunk.
 */

import { definePattern } from '../../../patterns/pattern-definition';
import { _unregisterLibraryPatternForTests, registerLibraryPattern } from '../../../patterns/registry';
import { describe, expect, it } from 'bun:test';

import {
	buildRelationGraph,
	entityScope,
	junctionIdentity,
} from '../../../emitters/relations/build-graph';
import {
	buildRelationsManifest,
	emptyRelationsManifest,
} from '../../../emitters/relations/emit-manifest';
import {
	RelationKeyCollisionError,
	type EntityRegistryEntry,
	type RelationsEmitContext,
} from '../../../emitters/relations/types';
import {
	EntityDefinitionSchema,
	type EntityDefinition,
} from '../../../schema/entity-definition.schema';
import {
	JunctionDefinitionSchema,
	type JunctionDefinition,
} from '../../../schema/junction-definition.schema';

// ---------------------------------------------------------------------------
// Fixture builders — plain objects, no fs.
// ---------------------------------------------------------------------------

function registryEntry(name: string, plural: string): EntityRegistryEntry {
	return {
		name,
		plural,
		table: plural,
		className: name,
		classNamePlural: plural,
		camelName: name,
		pluralCamelName: plural,
		sync: null,
	};
}

/**
 * Build a definition through the REAL schema, so a fixture that the parser
 * would reject cannot quietly pass here — and so the defaults these tests
 * depend on (notably `required`/`nullable` ⇒ `false`) are the parser's, not a
 * hand-written approximation.
 */
function definition(
	name: string,
	plural: string,
	fields: Record<string, unknown> = {},
	relationships: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
): EntityDefinition {
	return EntityDefinitionSchema.parse({
		entity: { name, plural },
		fields,
		relationships,
		...extra,
	});
}

function context(
	entries: Array<{ entry: EntityRegistryEntry; def: EntityDefinition }>,
	junctions: JunctionDefinition[] = [],
): RelationsEmitContext {
	return {
		entities: entries.map((e) => e.entry),
		definitions: new Map(entries.map((e) => [e.entry.name, e.def])),
		junctions,
		tenancyColumn: 'tenant_id',
	};
}

function junction(
	left: string,
	right: string,
	exposeOnParent: { left: boolean; right: boolean } = { left: true, right: true },
): JunctionDefinition {
	return JunctionDefinitionSchema.parse({
		pattern: 'Junction',
		between: [left, right],
		expose_on_parent: exposeOnParent,
	});
}

/** Find one edge by (table, key). */
function edge(ctx: RelationsEmitContext, table: string, key: string) {
	const found = buildRelationGraph(ctx)
		.tables.find((t) => t.table === table)
		?.edges.find((e) => e.key === key);
	if (!found) throw new Error(`no edge ${table}.${key}`);
	return found;
}

// ---------------------------------------------------------------------------

describe('buildRelationGraph — belongs_to', () => {
	const account = { entry: registryEntry('account', 'accounts'), def: definition('account', 'accounts') };

	const withFk = (fk: Record<string, unknown>, relExtra: Record<string, unknown> = {}) =>
		context([
			account,
			{
				entry: registryEntry('contact', 'contacts'),
				def: definition(
					'contact',
					'contacts',
					{ account_id: { type: 'uuid', ...fk } },
					{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id', ...relExtra } },
				),
			},
		]);

	it('puts the FK on the source table and the id on the target', () => {
		const e = edge(withFk({}), 'contacts', 'account');
		expect(e.cardinality).toBe('one');
		expect(e.from).toEqual({ table: 'contacts', column: 'accountId' });
		expect(e.to).toEqual({ table: 'accounts', column: 'id' });
	});

	it('a required FK column is not optional', () => {
		expect(edge(withFk({ required: true }), 'contacts', 'account').optional).toBe(false);
	});

	it('a written `required: false` on the FK is refused, pointing at `nullable: true` (#850)', () => {
		expect(() => withFk({ required: false })).toThrow(/'nullable: true'/);
	});

	it('an FK field declared without `nullable:` is NOT NULL, so not optional (#850)', () => {
		expect(edge(withFk({ index: true }), 'contacts', 'account').optional).toBe(false);
	});

	it('an explicitly nullable FK column is optional', () => {
		expect(edge(withFk({ nullable: true }), 'contacts', 'account').optional).toBe(true);
	});

	it('the schema forbids required + nullable, so the two can never disagree', () => {
		expect(() => withFk({ required: true, nullable: true })).toThrow(
			/cannot both be set/,
		);
	});

	it('a NOT NULL FK column with a default is not optional (#613)', () => {
		const fk = { required: false, nullable: false, default: '00000000-0000-0000-0000-000000000000' };
		expect(edge(withFk(fk), 'contacts', 'account').optional).toBe(false);
	});

	it('the schema forbids a NOT NULL FK column that is optional on create with no default', () => {
		expect(() => withFk({ nullable: false })).toThrow(/needs a 'default:'/);
	});

	it('an explicit relationship `nullable:` beats the field declaration', () => {
		expect(
			edge(withFk({ required: true }, { nullable: true }), 'contacts', 'account').optional,
		).toBe(true);
		expect(
			edge(withFk({ nullable: true }, { nullable: false }), 'contacts', 'account').optional,
		).toBe(false);
	});

	describe('a NOT NULL FK onto a target whose hop scope can drop it (#850)', () => {
		const onto = (targetExtra: Record<string, unknown>, sourceExtra: Record<string, unknown> = {}) =>
			context([
				{
					entry: registryEntry('account', 'accounts'),
					def: definition('account', 'accounts', {}, {}, targetExtra),
				},
				{
					entry: registryEntry('contact', 'contacts'),
					def: definition(
						'contact',
						'contacts',
						{ account_id: { type: 'uuid', required: true } },
						{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
						sourceExtra,
					),
				},
			]);

		it('is optional when the target soft-deletes — the include is null for a deleted row', () => {
			expect(edge(onto({ behaviors: ['soft_delete'] }), 'contacts', 'account').optional).toBe(true);
		});

		it('is optional when the target is user-tracked — another user’s row is filtered', () => {
			expect(edge(onto({ behaviors: ['user_tracking'] }), 'contacts', 'account').optional).toBe(
				true,
			);
		});

		it('stays required when source and target are both tenant-scoped (a cross-tenant FK is a data error)', () => {
			expect(
				edge(onto({ tenant_scoped: true }, { tenant_scoped: true }), 'contacts', 'account').optional,
			).toBe(false);
		});

		it('is optional when only the target is tenant-scoped — an unscoped source reads every tenant', () => {
			expect(edge(onto({ tenant_scoped: true }), 'contacts', 'account').optional).toBe(true);
		});
	});

	describe('a junction’s own edge to an endpoint (#850)', () => {
		const endpoints = (contactExtra: Record<string, unknown>) =>
			context(
				[
					{ entry: registryEntry('opportunity', 'opportunities'), def: definition('opportunity', 'opportunities') },
					{
						entry: registryEntry('contact', 'contacts'),
						def: definition('contact', 'contacts', {}, {}, contactExtra),
					},
				],
				[junction('opportunity', 'contact')],
			);

		it('is required onto an unscoped endpoint', () => {
			expect(edge(endpoints({}), 'opportunityContacts', 'contact').optional).toBe(false);
		});

		it('is optional onto a soft-deleting endpoint', () => {
			expect(
				edge(endpoints({ behaviors: ['soft_delete'] }), 'opportunityContacts', 'contact').optional,
			).toBe(true);
		});

		it('is optional onto a tenant-scoped endpoint — a junction declares no scope of its own', () => {
			expect(edge(endpoints({ tenant_scoped: true }), 'opportunityContacts', 'contact').optional).toBe(
				true,
			);
		});
	});

	it('an undeclared FK column is NOT NULL, so not optional (#850)', () => {
		const ctx = context([
			account,
			{
				entry: registryEntry('contact', 'contacts'),
				def: definition(
					'contact',
					'contacts',
					{},
					{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
				),
			},
		]);
		expect(edge(ctx, 'contacts', 'account').optional).toBe(false);
	});
});

describe('buildRelationGraph — has_many / has_one', () => {
	const ctx = context([
		{
			entry: registryEntry('account', 'accounts'),
			def: definition(
				'account',
				'accounts',
				{},
				{
					contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
					main_contact: { type: 'has_one', target: 'contact', foreign_key: 'primary_account_id' },
				},
			),
		},
		{ entry: registryEntry('contact', 'contacts'), def: definition('contact', 'contacts') },
	]);

	it('has_many joins this id to the FK on the TARGET table', () => {
		const e = edge(ctx, 'accounts', 'contacts');
		expect(e.cardinality).toBe('many');
		expect(e.from).toEqual({ table: 'accounts', column: 'id' });
		expect(e.to).toEqual({ table: 'contacts', column: 'accountId' });
		expect(e.optional).toBeUndefined();
	});

	it('has_one is the same join with one() and is always optional', () => {
		const e = edge(ctx, 'accounts', 'mainContact');
		expect(e.cardinality).toBe('one');
		expect(e.to).toEqual({ table: 'contacts', column: 'primaryAccountId' });
		expect(e.optional).toBe(true);
	});

	it('camelCases the YAML relationship name into the relation key', () => {
		expect(edge(ctx, 'accounts', 'mainContact').key).toBe('mainContact');
	});
});

describe('buildRelationGraph — naming comes from the registry', () => {
	it('uses the target entity’s declared plural, never a re-pluralization', () => {
		const ctx = context([
			{
				entry: registryEntry('contact', 'contacts'),
				def: definition(
					'contact',
					'contacts',
					{},
					{ people: { type: 'has_many', target: 'person', foreign_key: 'contact_id' } },
				),
			},
			// `pluralize('person')` is "people"; the YAML says "persons".
			{ entry: registryEntry('person', 'persons'), def: definition('person', 'persons') },
		]);
		expect(edge(ctx, 'contacts', 'people').targetTable).toBe('persons');
	});

	it('skips (with a warning) a relationship whose target has no YAML', () => {
		const ctx = context([
			{
				entry: registryEntry('contact', 'contacts'),
				def: definition(
					'contact',
					'contacts',
					{},
					{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
				),
			},
		]);
		const graph = buildRelationGraph(ctx);
		expect(graph.tables).toEqual([]);
		expect(graph.warnings).toHaveLength(1);
		expect(graph.warnings[0]).toContain("target entity 'account'");
	});
});

describe('buildRelationGraph — transitive (`through`) relationships', () => {
	// `foreign_key` on a transitive relationship names a column at the FAR end
	// of the path. A direct `accounts.id → updates.opportunity_id` edge would
	// join an account id against an opportunity FK — wrong rows, silently.
	const ctx = context([
		{
			entry: registryEntry('account', 'accounts'),
			def: definition(
				'account',
				'accounts',
				{},
				{
					owned_opportunities: {
						type: 'has_many',
						target: 'opportunity',
						foreign_key: 'account_id',
					},
					opportunity_updates: {
						type: 'has_many',
						target: 'update',
						foreign_key: 'opportunity_id',
						through: 'owned_opportunities.updates',
					},
				},
			),
		},
		{ entry: registryEntry('opportunity', 'opportunities'), def: definition('opportunity', 'opportunities') },
		{ entry: registryEntry('update', 'updates'), def: definition('update', 'updates') },
	]);
	const graph = buildRelationGraph(ctx);

	it('emits no edge for the transitive relationship', () => {
		const keys = graph.tables.flatMap((t) => t.edges.map((e) => `${t.table}.${e.key}`));
		expect(keys).not.toContain('accounts.opportunityUpdates');
		expect(graph.tables.flatMap((t) => t.edges).some((e) => e.targetTable === 'updates')).toBe(false);
	});

	it('still emits the direct relationship beside it', () => {
		expect(edge(ctx, 'accounts', 'ownedOpportunities').to).toEqual({
			table: 'opportunities',
			column: 'accountId',
		});
	});

	it('warns, naming the relationship and its path', () => {
		expect(graph.warnings).toHaveLength(1);
		expect(graph.warnings[0]).toContain('account.relationships.opportunity_updates');
		expect(graph.warnings[0]).toContain("through 'owned_opportunities.updates'");
	});
});

describe('buildRelationGraph — junctions', () => {
	const ctx = context(
		[
			{ entry: registryEntry('opportunity', 'opportunities'), def: definition('opportunity', 'opportunities') },
			{ entry: registryEntry('contact', 'contacts'), def: definition('contact', 'contacts') },
		],
		[junction('opportunity', 'contact')],
	);

	it('derives the junction table identity exactly as the junction template does', () => {
		expect(junctionIdentity(junction('opportunity', 'contact'))).toEqual({
			name: 'opportunity_contact',
			plural: 'opportunity_contacts',
			tableVar: 'opportunityContacts',
		});
	});

	it('emits a .through() hop on each parent', () => {
		const left = edge(ctx, 'opportunities', 'contacts');
		expect(left.cardinality).toBe('many');
		expect(left.from.through).toEqual({ table: 'opportunityContacts', column: 'opportunityId' });
		expect(left.to.through).toEqual({ table: 'opportunityContacts', column: 'contactId' });

		const right = edge(ctx, 'contacts', 'opportunities');
		expect(right.from.through).toEqual({ table: 'opportunityContacts', column: 'contactId' });
		expect(right.to.through).toEqual({ table: 'opportunityContacts', column: 'opportunityId' });
	});

	it('emits the row-level edge to the junction table itself', () => {
		const e = edge(ctx, 'opportunities', 'opportunityContacts');
		expect(e.targetTable).toBe('opportunityContacts');
		expect(e.to).toEqual({ table: 'opportunityContacts', column: 'opportunityId' });
	});

	it('emits the junction’s own two belongs_to edges', () => {
		expect(edge(ctx, 'opportunityContacts', 'opportunity').optional).toBe(false);
		expect(edge(ctx, 'opportunityContacts', 'contact').to).toEqual({
			table: 'contacts',
			column: 'id',
		});
	});

	it('ignores expose_on_parent — that is a service knob, not a graph knob', () => {
		// CGP-60's `expose_on_parent` suppresses the parent SERVICE's fan-out
		// methods. The graph is what a traversal is allowed to walk, and every
		// declared relationship is navigable internally by default (PLAN §5A.6);
		// HTTP exposure is REL-2's separate allowlist.
		const closed = context(
			[
				{ entry: registryEntry('opportunity', 'opportunities'), def: definition('opportunity', 'opportunities') },
				{ entry: registryEntry('contact', 'contacts'), def: definition('contact', 'contacts') },
			],
			[junction('opportunity', 'contact', { left: false, right: false })],
		);
		expect(edge(closed, 'opportunities', 'contacts').from.through).toEqual({
			table: 'opportunityContacts',
			column: 'opportunityId',
		});
		expect(edge(closed, 'contacts', 'opportunities').cardinality).toBe('many');
	});

	it('skips (with a warning) a junction whose endpoint has no YAML', () => {
		const partial = context(
			[{ entry: registryEntry('opportunity', 'opportunities'), def: definition('opportunity', 'opportunities') }],
			[junction('opportunity', 'contact')],
		);
		const graph = buildRelationGraph(partial);
		expect(graph.tables).toEqual([]);
		expect(graph.warnings[0]).toContain("'contact'");
	});
});

describe('buildRelationGraph — collisions fail loudly', () => {
	it('throws when a declared relationship and a junction claim one key', () => {
		const ctx = context(
			[
				{
					entry: registryEntry('opportunity', 'opportunities'),
					def: definition(
						'opportunity',
						'opportunities',
						{},
						// Same key the junction derives for the many-to-many hop.
						{ contacts: { type: 'has_many', target: 'contact', foreign_key: 'opportunity_id' } },
					),
				},
				{ entry: registryEntry('contact', 'contacts'), def: definition('contact', 'contacts') },
			],
			[junction('opportunity', 'contact')],
		);
		expect(() => buildRelationGraph(ctx)).toThrow(RelationKeyCollisionError);
		try {
			buildRelationGraph(ctx);
		} catch (err) {
			// Both contributors are named, so the author knows what to rename.
			expect((err as Error).message).toContain('opportunity.relationships.contacts');
			expect((err as Error).message).toContain('junction opportunity_contact');
		}
	});
});

describe('buildRelationGraph — determinism', () => {
	it('sorts tables by identifier and relations by key', () => {
		const ctx = context([
			{
				entry: registryEntry('zeta', 'zetas'),
				def: definition(
					'zeta',
					'zetas',
					{},
					{
						beta: { type: 'belongs_to', target: 'alpha', foreign_key: 'b_id' },
						alpha: { type: 'belongs_to', target: 'alpha', foreign_key: 'a_id' },
					},
				),
			},
			{ entry: registryEntry('alpha', 'alphas'), def: definition('alpha', 'alphas') },
		]);
		const graph = buildRelationGraph(ctx);
		expect(graph.tables.map((t) => t.table)).toEqual(['zetas']);
		expect(graph.tables[0]!.edges.map((e) => e.key)).toEqual(['alpha', 'beta']);
	});
});

describe('manifest rendering', () => {
	it('emits an empty manifest a zero-entity project can still compile against', () => {
		const empty = emptyRelationsManifest();
		expect(empty).toContain("import * as schema from './schema';");
		expect(empty).toContain('export const relations = defineRelations(schema, () => ({}));');
		expect(empty).toBe(buildRelationsManifest({ tables: [], warnings: [], entityScopes: [] }));
		// SCOPES / rootScope exist on every project; an empty one imports nothing from
		// the runtime (`project init` writes it before any runtime alias resolves).
		expect(empty).not.toContain('scope-filters');
		expect(empty).toContain('export const SCOPES = {} as const;');
		expect(empty).toContain('export const rootScope = {};');
	});

	it('emits SCOPES and rootScope on a project that scopes nothing (READ-1 §5.1)', () => {
		// A loader written against `rootScope.<t>` today keeps applying the root
		// scope the day the entity becomes scoped — the map is never absent.
		const out = buildRelationsManifest({
			tables: [],
			warnings: [],
			entityScopes: [{ table: 'notes', scope: null }],
		});
		expect(out).toContain(
			"import { scopedRoot, tableScope, UNSCOPED, type ScopeConfig } from '@shared/base-classes/scope-filters';",
		);
		expect(out).toContain('\tnotes: tableScope(schema.notes, UNSCOPED),');
		expect(out).toContain('\tnotes: (owner: string) => scopedRoot(SCOPES.notes, owner),');
		expect(out).not.toContain('hopScope');
	});

	it('carries the @generated banner', () => {
		expect(emptyRelationsManifest()).toStartWith('// @generated by @pattern-stack/codegen');
	});
});

// ---------------------------------------------------------------------------
// REL-2 (#587) — the per-hop scope predicate
// ---------------------------------------------------------------------------

describe('entityScope', () => {
	it('folds in PATTERN-implied behaviors, as the repository does (READ-1 review #9)', () => {
		// A pattern implying soft_delete makes the repository filter deleted rows
		// (entity-locals folds resolveImpliedBehaviors). The hops, SCOPES and
		// rootScope must agree — one declaration, one posture (charter I1).
		registerLibraryPattern(
			definePattern({
				name: 'ReadOneSoftDeleting',
				extends: ['Base'],
				repositoryClass: 'BaseRepository',
				serviceClass: 'BaseService',
				repositoryImport: '@shared/base-classes/base-repository',
				serviceImport: '@shared/base-classes/base-service',
				repositoryInheritedMethods: ['findById'],
				serviceInheritedMethods: ['findById'],
				impliedBehaviors: ['soft_delete'],
				description: 'test-only: implies soft_delete',
			}),
		);
		try {
			const def = definition('a', 'as');
			def.entity.pattern = 'ReadOneSoftDeleting';
			expect(entityScope(def, 'tenant_id')).toEqual({
				tenantScoped: false,
				softDelete: true,
				userTracking: false,
				enforcement: 'lenient',
			});
		} finally {
			// The registry is process-wide: leave it as the test found it.
			_unregisterLibraryPatternForTests('ReadOneSoftDeleting');
		}
	});

	it('is null when nothing is declared — the manifest maps it to UNSCOPED', () => {
		expect(entityScope(definition('a', 'as'), 'tenant_id')).toBeNull();
		expect(
			entityScope(definition('a', 'as', {}, {}, { behaviors: ['timestamps'] }), 'tenant_id'),
		).toBeNull();
	});

	it('reads the soft_delete / user_tracking behaviors and the tenant_scoped flag', () => {
		expect(
			entityScope(
				definition('a', 'as', {}, {}, { behaviors: ['timestamps', 'soft_delete'] }),
				'tenant_id',
			),
		).toEqual({
			tenantScoped: false,
			softDelete: true,
			userTracking: false,
			enforcement: 'lenient',
		});
		expect(
			entityScope(definition('a', 'as', {}, {}, { behaviors: ['user_tracking'] }), 'tenant_id'),
		).toEqual({
			tenantScoped: false,
			softDelete: false,
			userTracking: true,
			enforcement: 'lenient',
		});
	});

	it('accepts the object form of a behavior declaration', () => {
		expect(
			entityScope(
				definition('a', 'as', {}, {}, { behaviors: [{ name: 'soft_delete' }] }),
				'tenant_id',
			)?.softDelete,
		).toBe(true);
	});

	// TEN-1 §3.4: a tenant-scoped entity is STRICT, so a traversal into it with no
	// ambient boundary throws at query build rather than reading every tenant.
	it('a tenant-scoped entity is strict; a user_tracking-only one stays lenient', () => {
		expect(
			entityScope(definition('a', 'as', {}, {}, { tenant_scoped: true }), 'tenant_id')?.enforcement,
		).toBe('strict');
		expect(
			entityScope(definition('a', 'as', {}, {}, { behaviors: ['user_tracking'] }), 'tenant_id')
				?.enforcement,
		).toBe('lenient');
	});
});

describe('every edge carries its TARGET\'s scope', () => {
	it('because `relationToSQL` applies a relation\'s where to the target table', () => {
		const ctx = context([
			{
				entry: registryEntry('account', 'accounts'),
				def: definition(
					'account',
					'accounts',
					{ contact_id: { type: 'uuid' } },
					{ contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' } },
					{ behaviors: ['soft_delete'] },
				),
			},
			{
				entry: registryEntry('contact', 'contacts'),
				def: definition(
					'contact',
					'contacts',
					{ account_id: { type: 'uuid', required: true } },
					{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
					{ tenant_scoped: true },
				),
			},
		]);
		const graph = buildRelationGraph(ctx);
		const byTable = new Map(graph.tables.map((t) => [t.table, t.edges]));

		// accounts.contacts targets CONTACTS, which is tenant-scoped.
		expect(byTable.get('accounts')?.[0]?.targetScope).toEqual({
			tenantScoped: true,
			tenantColumn: 'tenantId',
			softDelete: false,
			userTracking: false,
			enforcement: 'strict',
		});
		// contacts.account targets ACCOUNTS, which declares soft_delete.
		expect(byTable.get('contacts')?.[0]?.targetScope).toEqual({
			tenantScoped: false,
			softDelete: true,
			userTracking: false,
			enforcement: 'lenient',
		});
	});

	// REL-2 §1.5: a junction declares no scope of its own, so no hop INTO it
	// carries a predicate. A characterisation test — the day junctions become
	// scopable, this is the gate that says so.
	it('a hop into the junction TABLE carries no predicate; its own edges do', () => {
		const junctionDef = junction('opportunity', 'contact');
		const ctx = context(
			[
				{
					entry: registryEntry('contact', 'contacts'),
					def: definition('contact', 'contacts', {}, {}, { tenant_scoped: true }),
				},
				{
					entry: registryEntry('opportunity', 'opportunities'),
					def: definition('opportunity', 'opportunities', {}, {}, { tenant_scoped: true }),
				},
			],
			[junctionDef],
		);
		const graph = buildRelationGraph(ctx);
		const byTable = new Map(graph.tables.map((t) => [t.table, t.edges]));

		const toJunctionRows = byTable
			.get('contacts')
			?.find((e) => e.targetTable === 'opportunityContacts');
		expect(toJunctionRows?.targetScope).toBeNull();

		// The junction's own belongs_to edges DO carry the endpoints' scope.
		for (const edge of byTable.get('opportunityContacts') ?? []) {
			expect(edge.targetScope?.tenantScoped).toBe(true);
		}
	});
});

// #791 — the manifest's scope constant names the tenant column, so a REL-2 hop
// into an entity scoped on another column filters on THAT column.
describe('the tenant column travels with the scope (#791)', () => {
	const entries = () => [
		{
			entry: registryEntry('account', 'accounts'),
			def: definition(
				'account',
				'accounts',
				{ organization_id: { type: 'uuid', required: true } },
				{ contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' } },
				{ tenant_scoped: true },
			),
		},
		{
			entry: registryEntry('contact', 'contacts'),
			def: definition(
				'contact',
				'contacts',
				{ account_id: { type: 'uuid', required: true } },
				{ account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
				{ tenant_scoped: { column: 'team_id' } },
			),
		},
	];

	it('entityScope always carries tenantColumn on a scoped entity', () => {
		const [account, contact] = entries();
		expect(entityScope(account!.def, 'tenant_id')).toEqual({
			tenantScoped: true,
			tenantColumn: 'tenantId',
			softDelete: false,
			userTracking: false,
			enforcement: 'strict',
		});
		expect(entityScope(account!.def, 'organization_id')?.tenantColumn).toBe('organizationId');
		// The entity's own column wins over the project default.
		expect(entityScope(contact!.def, 'organization_id')?.tenantColumn).toBe('teamId');
	});

	it('the manifest constants render it, from the project default and the override', () => {
		const out = buildRelationsManifest(
			buildRelationGraph({ ...context(entries()), tenancyColumn: 'organization_id' }),
		);
		expect(out).toContain(
			"const ACCOUNTS_SCOPE = tableScope(schema.accounts, { tenantScoped: true, tenantColumn: 'organizationId', softDelete: false, userTracking: false, enforcement: 'strict' });",
		);
		expect(out).toContain(
			"const CONTACTS_SCOPE = tableScope(schema.contacts, { tenantScoped: true, tenantColumn: 'teamId', softDelete: false, userTracking: false, enforcement: 'strict' });",
		);
	});

	it('a default project renders tenantColumn too — it is never omitted', () => {
		const out = buildRelationsManifest(buildRelationGraph(context(entries())));
		expect(out).toContain(
			"const ACCOUNTS_SCOPE = tableScope(schema.accounts, { tenantScoped: true, tenantColumn: 'tenantId', softDelete: false, userTracking: false, enforcement: 'strict' });",
		);
	});
});
