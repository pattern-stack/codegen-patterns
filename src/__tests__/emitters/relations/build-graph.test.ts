/**
 * Relations emitter — graph construction unit tests (ADR-044, REL-1).
 *
 * The golden snapshot locks the whole emitted file; these lock the RULES, so a
 * regression names itself instead of showing up as a diff hunk.
 */

import { describe, expect, it } from 'bun:test';

import { buildRelationGraph, junctionIdentity } from '../../../emitters/relations/build-graph';
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
): EntityDefinition {
	return EntityDefinitionSchema.parse({
		entity: { name, plural, table: plural },
		fields,
		relationships,
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
					{ account_id: { type: 'uuid', required: false, nullable: false, ...fk } },
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

	it('a non-required FK column is optional', () => {
		expect(edge(withFk({ required: false }), 'contacts', 'account').optional).toBe(true);
	});

	it('an explicitly nullable FK column is optional', () => {
		expect(edge(withFk({ nullable: true }), 'contacts', 'account').optional).toBe(true);
	});

	it('the schema forbids required + nullable, so the two can never disagree', () => {
		// Why `belongsToOptional` reads `required` alone and never `nullable`.
		expect(() => withFk({ required: true, nullable: true })).toThrow(
			/cannot both be set/,
		);
	});

	it('an explicit relationship `nullable:` beats the field declaration', () => {
		expect(
			edge(withFk({ required: true }, { nullable: true }), 'contacts', 'account').optional,
		).toBe(true);
		expect(
			edge(withFk({ required: false }, { nullable: false }), 'contacts', 'account').optional,
		).toBe(false);
	});

	it('an undeclared FK column is optional', () => {
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
		expect(edge(ctx, 'contacts', 'account').optional).toBe(true);
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
		expect(empty).toBe(buildRelationsManifest({ tables: [], warnings: [] }));
	});

	it('carries the @generated banner', () => {
		expect(emptyRelationsManifest()).toStartWith('// @generated by @pattern-stack/codegen');
	});
});
