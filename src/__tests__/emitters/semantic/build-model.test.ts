/**
 * Semantic emitter — build-model units (SEM-2, ADR-045).
 *
 * The golden snapshot proves the whole tree; these prove each mapping rule in
 * isolation, so a regression names itself instead of showing up as a diff.
 * Contexts are built by hand — the builder is pure and takes no fs.
 */

import { describe, expect, it } from 'bun:test';

import type { ParsedEntity, ParsedField, ParsedFieldAnalytics } from '../../../analyzer/types';
import type { EntityRegistryEntry } from '../../../parser/entity-registry';
import type { JunctionDefinition } from '../../../schema/junction-definition.schema';
import { buildSemanticModel, junctionIdentity } from '../../../emitters/semantic/build-model';
import type { SemanticEmitContext } from '../../../emitters/semantic/types';

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

function field(
	name: string,
	type: string,
	analytics: ParsedFieldAnalytics = {},
	extra: Partial<ParsedField> = {},
): ParsedField {
	return {
		name,
		type,
		required: false,
		nullable: false,
		unique: false,
		index: false,
		constraints: {},
		ui: {},
		analytics,
		...extra,
	};
}

function parsedEntity(
	name: string,
	plural: string,
	fields: ParsedField[],
	relationships: Array<[string, ParsedEntity['relationships'] extends Map<string, infer R> ? R : never]> = [],
	analytics?: ParsedEntity['analytics'],
): ParsedEntity {
	return {
		name,
		plural,
		table: plural,
		expose: ['repository'],
		folderStructure: 'nested',
		fields: new Map(fields.map((f) => [f.name, f])),
		relationships: new Map(relationships),
		behaviors: [],
		sourcePath: `entities/${name}.yaml`,
		...(analytics ? { analytics } : {}),
	};
}

function context(
	entities: ParsedEntity[],
	junctions: JunctionDefinition[] = [],
): SemanticEmitContext {
	return {
		entities: entities.map((e) => registryEntry(e.name, e.plural)),
		parsed: new Map(entities.map((e) => [e.name, e])),
		junctions,
	};
}

const rel = (
	type: 'belongs_to' | 'has_many' | 'has_one',
	target: string,
	foreignKey: string,
	through?: string,
) => ({ name: target, type, target, foreignKey, resolved: true, ...(through ? { through } : {}) });

// ---------------------------------------------------------------------------

describe('field type mapping', () => {
	const cases: Array<[string, string]> = [
		['string', 'string'],
		['integer', 'number'],
		['decimal', 'number'],
		['boolean', 'boolean'],
		['uuid', 'uuid'],
		['date', 'datetime'],
		['datetime', 'datetime'],
		['json', 'json'],
		['enum', 'enum'],
	];

	for (const [yaml, agg] of cases) {
		it(`maps ${yaml} → ${agg}`, () => {
			const model = buildSemanticModel(
				context([parsedEntity('thing', 'things', [field('f', yaml)])]),
			);
			expect(model.entities[0]!.fields.f!.type).toBe(agg as never);
		});
	}

	it('omits string_array and entity_ref — neither has an AggColType', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [
					field('tags', 'string_array'),
					field('linked_to', 'entity_ref'),
					field('name', 'string'),
				]),
			]),
		);
		expect(Object.keys(model.entities[0]!.fields)).toEqual(['name']);
	});
});

describe('analytics tags', () => {
	it('copies role / aggs / additivity verbatim', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [
					field('amount', 'decimal', {
						role: 'measure',
						aggs: ['sum', 'avg'],
						additivity: 'additive',
					}),
				]),
			]),
		);
		expect(model.entities[0]!.fields.amount).toEqual({
			key: 'amount',
			type: 'number',
			role: 'measure',
			aggs: ['sum', 'avg'],
			additivity: 'additive',
			column: 'amount',
		});
	});

	it('always emits `column` explicitly rather than relying on the package default', () => {
		const model = buildSemanticModel(
			context([parsedEntity('thing', 'things', [field('name', 'string')])]),
		);
		expect(model.entities[0]!.fields.name!.column).toBe('name');
	});

	it('marks an enum with choices as having a declared value domain', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [
					field('stage', 'enum', { role: 'dimension' }, { choices: ['a', 'b'] }),
					field('other', 'enum', { role: 'dimension' }),
				]),
			]),
		);
		expect(model.entities[0]!.fields.stage!.hasDeclaredDomain).toBe(true);
		expect(model.entities[0]!.fields.other!.hasDeclaredDomain).toBeUndefined();
	});

	it('marks an enum with choices_from as having a declared value domain', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [
					field('stage', 'enum', { role: 'dimension' }, { choicesFrom: './stages.yaml' }),
				]),
			]),
		);
		expect(model.entities[0]!.fields.stage!.hasDeclaredDomain).toBe(true);
	});

	it('derives scope columns to dimensions, and never to measures', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [
					field('tenant_id', 'uuid'),
					field('organization_id', 'uuid'),
					field('user_id', 'uuid'),
				]),
			]),
		);
		for (const key of ['tenant_id', 'organization_id', 'user_id']) {
			expect(model.entities[0]!.fields[key]!.role).toBe('dimension');
		}
	});

	it('leaves an explicit role on a scope column alone', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [field('user_id', 'uuid', { role: 'dimension' })]),
			]),
		);
		expect(model.entities[0]!.fields.user_id!.role).toBe('dimension');
	});

	it('keeps an EXPLICITLY declared lifecycle field untagged unless the author tags it', () => {
		// Declared in `fields:` rather than contributed by a behavior — the
		// author owns it, so nothing is derived onto it.
		const model = buildSemanticModel(
			context([
				parsedEntity('thing', 'things', [field('closed_at', 'datetime')]),
			]),
		);
		expect(model.entities[0]!.fields.closed_at).toEqual({
			key: 'closed_at',
			type: 'datetime',
			column: 'closed_at',
		});
	});
});

describe('behavior-contributed columns (SEM-3)', () => {
	const withBehaviors = (behaviors: string[], fields: ParsedField[] = []) => {
		const entity = parsedEntity('thing', 'things', [field('name', 'string'), ...fields]);
		entity.behaviors = behaviors;
		return context([entity]);
	};

	it('expands timestamps into dimensions', () => {
		const model = buildSemanticModel(withBehaviors(['timestamps']));
		expect(model.entities[0]!.fields.created_at).toEqual({
			key: 'created_at',
			type: 'datetime',
			role: 'dimension',
			column: 'created_at',
		});
		expect(model.entities[0]!.fields.updated_at!.role).toBe('dimension');
	});

	it('expands soft_delete and user_tracking', () => {
		const model = buildSemanticModel(withBehaviors(['soft_delete', 'user_tracking']));
		const fields = model.entities[0]!.fields;
		expect(fields.deleted_at!.role).toBe('dimension');
		// created_by / updated_by are uuids — registered so they resolve in a
		// filter, but not derived to dimensions.
		expect(fields.created_by).toEqual({ key: 'created_by', type: 'uuid', column: 'created_by' });
		expect(fields.updated_by!.role).toBeUndefined();
	});

	it('never derives `time` — which column is THE time axis is the author\'s call', () => {
		const model = buildSemanticModel(withBehaviors(['timestamps']));
		expect(model.entities[0]!.fields.created_at!.time).toBeUndefined();
	});

	it('an explicitly declared field wins over the behavior default', () => {
		const model = buildSemanticModel(
			withBehaviors(
				['timestamps'],
				[field('created_at', 'datetime', { role: 'dimension', time: true })],
			),
		);
		expect(model.entities[0]!.fields.created_at).toEqual({
			key: 'created_at',
			type: 'datetime',
			role: 'dimension',
			time: true,
			column: 'created_at',
		});
	});

	it('adds nothing when no behaviors are declared', () => {
		const model = buildSemanticModel(withBehaviors([]));
		expect(Object.keys(model.entities[0]!.fields)).toEqual(['name']);
	});

	it('ignores an unknown behavior name rather than throwing', () => {
		const model = buildSemanticModel(withBehaviors(['not_a_behavior']));
		expect(Object.keys(model.entities[0]!.fields)).toEqual(['name']);
	});
});

describe('relationships', () => {
	it('emits all three kinds, has_one faithfully', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'account',
					'accounts',
					[field('name', 'string')],
					[
						['contacts', rel('has_many', 'contact', 'account_id')],
						['primary_contact', rel('has_one', 'contact', 'primary_for_account_id')],
					],
				),
				parsedEntity(
					'contact',
					'contacts',
					[field('name', 'string')],
					[['account', rel('belongs_to', 'account', 'account_id')]],
				),
			]),
		);
		const account = model.entities.find((e) => e.name === 'account')!;
		expect(account.relationships.contacts!.kind).toBe('has_many');
		expect(account.relationships.primary_contact).toEqual({
			kind: 'has_one',
			target: 'contact',
			fk: 'primary_for_account_id',
		});
		const contact = model.entities.find((e) => e.name === 'contact')!;
		expect(contact.relationships.account!.kind).toBe('belongs_to');
	});

	it('keys relationships by the YAML name verbatim, not camelCased', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'account',
					'accounts',
					[field('name', 'string')],
					[['parent_account', rel('belongs_to', 'account', 'parent_account_id')]],
				),
			]),
		);
		expect(Object.keys(model.entities[0]!.relationships)).toEqual(['parent_account']);
	});

	it('does NOT emit a through: relationship', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'opportunity',
					'opportunities',
					[field('name', 'string')],
					[['account_contacts', rel('has_many', 'contact', 'account_id', 'account.contacts')]],
				),
				parsedEntity('contact', 'contacts', [field('name', 'string')]),
			]),
		);
		const opp = model.entities.find((e) => e.name === 'opportunity')!;
		expect(Object.keys(opp.relationships)).toEqual([]);
	});

	it('warns and omits a relationship whose target is not declared', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'opportunity',
					'opportunities',
					[field('name', 'string')],
					[['ghost', rel('belongs_to', 'nowhere', 'nowhere_id')]],
				),
			]),
		);
		expect(Object.keys(model.entities[0]!.relationships)).toEqual([]);
		expect(model.warnings).toHaveLength(1);
		expect(model.warnings[0]).toContain("target 'nowhere' is not a declared entity");
	});
});

describe('junctions', () => {
	const junction = (a: string, b: string): JunctionDefinition =>
		({ pattern: 'Junction', between: [a, b] }) as unknown as JunctionDefinition;

	it('derives name, plural and a CAMEL-cased table var', () => {
		expect(junctionIdentity(junction('opportunity', 'contact'))).toEqual({
			name: 'opportunity_contact',
			plural: 'opportunity_contacts',
			table: 'opportunity_contacts',
			tableVar: 'opportunityContacts',
		});
	});

	it('emits a junction entry with meta.kind junction and two belongs_to', () => {
		const model = buildSemanticModel(
			context(
				[
					parsedEntity('opportunity', 'opportunities', [field('name', 'string')]),
					parsedEntity('contact', 'contacts', [field('name', 'string')]),
				],
				[junction('opportunity', 'contact')],
			),
		);
		const j = model.entities.find((e) => e.name === 'opportunity_contact')!;
		expect(j.kind).toBe('junction');
		expect(j.relationships).toEqual({
			contact: { kind: 'belongs_to', target: 'contact', fk: 'contact_id' },
			opportunity: { kind: 'belongs_to', target: 'opportunity', fk: 'opportunity_id' },
		});
		expect(j.searchableColumns).toEqual([]);
	});

	it('adds the inverse has_many to each endpoint, keyed by the junction plural', () => {
		const model = buildSemanticModel(
			context(
				[
					parsedEntity('opportunity', 'opportunities', [field('name', 'string')]),
					parsedEntity('contact', 'contacts', [field('name', 'string')]),
				],
				[junction('opportunity', 'contact')],
			),
		);
		expect(
			model.entities.find((e) => e.name === 'opportunity')!.relationships
				.opportunity_contacts,
		).toEqual({ kind: 'has_many', target: 'opportunity_contact', fk: 'opportunity_id' });
		expect(
			model.entities.find((e) => e.name === 'contact')!.relationships.opportunity_contacts,
		).toEqual({ kind: 'has_many', target: 'opportunity_contact', fk: 'contact_id' });
	});

	describe('fields — exactly the columns the junction template emits', () => {
		const endpoints = [
			parsedEntity('opportunity', 'opportunities', [field('name', 'string')]),
			parsedEntity('contact', 'contacts', [field('name', 'string')]),
		];
		const junctionOf = (extra: Record<string, unknown>) =>
			buildSemanticModel(
				context(endpoints, [
					{ pattern: 'Junction', between: ['opportunity', 'contact'], ...extra } as unknown as JunctionDefinition,
				]),
			).entities.find((e) => e.name === 'opportunity_contact')!;

		it('emits the FKs, BaseJunctionFields and timestamps, and no phantom id', () => {
			const j = junctionOf({});
			expect(Object.keys(j.fields).sort()).toEqual([
				'confidence',
				'contact_id',
				'created_at',
				'ended_at',
				'is_primary',
				'matched_at',
				'opportunity_id',
				'sourced_from',
				'started_at',
				'updated_at',
			]);
			expect(j.fields.id).toBeUndefined();
			expect(j.compositeKey).toEqual(['opportunity_id', 'contact_id']);
		});

		it('drops the temporal and provenance columns when opted out', () => {
			const j = junctionOf({ temporal: false, sourced: false });
			expect(Object.keys(j.fields).sort()).toEqual([
				'contact_id',
				'created_at',
				'is_primary',
				'opportunity_id',
				'updated_at',
			]);
		});

		it('emits a role with choices as a keyed dimension with a declared domain', () => {
			const j = junctionOf({ fields: { role: { type: 'enum', choices: ['champion'] } } });
			expect(j.fields.role).toEqual({
				key: 'role',
				type: 'enum',
				column: 'role',
				role: 'dimension',
				hasDeclaredDomain: true,
			});
			expect(j.compositeKey).toEqual(['opportunity_id', 'contact_id', 'role']);
		});

		it('emits no role column for a role without choices — the template generates none (#690)', () => {
			const j = junctionOf({ fields: { role: { type: 'enum', values: ['champion'] } } });
			expect(j.fields.role).toBeUndefined();
			expect(j.compositeKey).toEqual(['opportunity_id', 'contact_id']);
		});

		it('types payload fields the way the template types their columns', () => {
			const j = junctionOf({
				fields: {
					score: { type: 'decimal' },
					stage: { type: 'enum', choices: ['a'] },
					loose: { type: 'enum' },
					tags: { type: 'string_array' },
				},
			});
			expect(j.fields.score!.type).toBe('number');
			expect(j.fields.stage).toMatchObject({ type: 'enum', hasDeclaredDomain: true });
			expect(j.fields.loose!.type).toBe('string');
			expect(j.fields.tags!.type).toBe('string');
			expect(j.fields.score!.role).toBeUndefined();
		});
	});

	it('warns and omits a junction whose endpoint is not a declared entity', () => {
		const model = buildSemanticModel(
			context(
				[parsedEntity('opportunity', 'opportunities', [field('name', 'string')])],
				[junction('opportunity', 'ghost')],
			),
		);
		expect(model.entities.map((e) => e.name)).toEqual(['opportunity']);
		expect(model.warnings[0]).toContain('endpoint(s) ghost');
	});
});

describe('searchableColumns', () => {
	it('keeps text columns and drops ids, FKs, enums and non-strings', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'contact',
					'contacts',
					[
						field('first_name', 'string'),
						field('email', 'string'),
						field('external_id', 'string'),
						field('legacy_id', 'string'),
						field('account_id', 'uuid'),
						field('stage', 'enum'),
						field('amount', 'decimal'),
					],
					[['account', rel('belongs_to', 'account', 'account_id')]],
				),
				parsedEntity('account', 'accounts', [field('name', 'string')]),
			]),
		);
		expect(
			model.entities.find((e) => e.name === 'contact')!.searchableColumns,
		).toEqual(['email', 'first_name']);
	});

	it('drops a string column that IS a declared belongs_to FK', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'contact',
					'contacts',
					[field('account_ref', 'string'), field('name', 'string')],
					[['account', rel('belongs_to', 'account', 'account_ref')]],
				),
				parsedEntity('account', 'accounts', [field('name', 'string')]),
			]),
		);
		expect(
			model.entities.find((e) => e.name === 'contact')!.searchableColumns,
		).toEqual(['name']);
	});
});

describe('catalog', () => {
	it('emits composites only, sorted, and never an atomic entry', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity(
					'opportunity',
					'opportunities',
					[
						field('amount', 'decimal', {
							role: 'measure',
							aggs: ['sum'],
							additivity: 'additive',
						}),
					],
					[],
					{
						metrics: {
							win_rate: {
								type: 'ratio',
								numerator: 'amount.sum',
								denominator: 'amount.sum',
							},
							gap: {
								type: 'derived',
								expr: { op: '-', left: { ref: 'amount.sum' }, right: { lit: 1 } },
							},
						},
					},
				),
			]),
		);
		expect(model.metrics.map((m) => m.name)).toEqual(['gap', 'win_rate']);
		expect(model.metrics.every((m) => m.kind !== ('atomic' as never))).toBe(true);
	});

	it('is empty when nothing declares metrics', () => {
		const model = buildSemanticModel(
			context([parsedEntity('thing', 'things', [field('name', 'string')])]),
		);
		expect(model.metrics).toEqual([]);
	});
});

describe('ordering', () => {
	it('sorts entities, fields and relationships regardless of input order', () => {
		const model = buildSemanticModel(
			context([
				parsedEntity('zebra', 'zebras', [field('z', 'string'), field('a', 'string')]),
				parsedEntity('alpha', 'alphas', [field('b', 'string')]),
			]),
		);
		expect(model.entities.map((e) => e.name)).toEqual(['alpha', 'zebra']);
		expect(Object.keys(model.entities[1]!.fields)).toEqual(['a', 'z']);
	});
});
