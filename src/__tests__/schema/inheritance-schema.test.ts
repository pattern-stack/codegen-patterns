/**
 * RFC-0006 single-file rules (#875, slice S1): the new keys parse, and the
 * rules that read ONE entity's YAML fail with a message naming the entity.
 * Cross-entity rules are in `src/__tests__/parser/validate-inheritance.test.ts`.
 */

import { describe, expect, it } from 'bun:test';

import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import {
	inheritsOf,
	notGeneratedYetMessage,
	unemittedInheritanceKeys,
} from '../../schema/inheritance';
import { loadFamily, rawFixture, schemaIssues } from '../parser/inheritance-family';

const joined = (issues: string[]) => issues.join('\n');

describe('the keys', () => {
	it('every fixture parses through the schema', () => {
		expect(loadFamily().length).toBe(11);
	});

	it('inherits: short and long form', () => {
		const meeting = EntityDefinitionSchema.parse(rawFixture('meeting'));
		expect(inheritsOf(meeting)).toEqual({ base: 'communication', as: 'meeting' });
		const part = EntityDefinitionSchema.parse(rawFixture('transcript_communication_part'));
		expect(inheritsOf(part)).toEqual({ base: 'communication_part', as: 'meeting' });
		const longNoAs = EntityDefinitionSchema.parse(rawFixture('email', (r) => (r.inherits = { base: 'communication' })));
		expect(inheritsOf(longNoAs)).toEqual({ base: 'communication', as: 'email' });
	});

	it('inherits: rejects an unknown sub-key and a non-snake name', () => {
		expect(schemaIssues(rawFixture('meeting', (r) => (r.inherits = { base: 'communication', kind: 'x' })))).not.toEqual([]);
		expect(joined(schemaIssues(rawFixture('meeting', (r) => (r.inherits = 'Communication'))))).toContain("'inherits' must name an entity in snake_case");
	});

	it('match: a map, or a list of names; never on has_many', () => {
		expect(schemaIssues(rawFixture('communication_part'))).toEqual([]);
		expect(
			schemaIssues(rawFixture('communication_part', (r) => (r.relationships.communication.match = ['kind']))),
		).toEqual([]);
		expect(
			joined(
				schemaIssues(
					rawFixture('meeting', (r) => {
						r.relationships.transcripts.match = { id: 'id' };
					}),
				),
			),
		).toContain("'match' is only valid on a 'belongs_to' relationship");
		expect(schemaIssues(rawFixture('communication_part', (r) => (r.relationships.communication.match = {})))).not.toEqual([]);
		expect(schemaIssues(rawFixture('communication_part', (r) => (r.relationships.communication.match = [])))).not.toEqual([]);
	});

	it('choices_of: only on an enum, and not with choices or choices_from', () => {
		expect(
			joined(schemaIssues(rawFixture('communication_part', (r) => (r.fields.kind.choices = ['a'])))),
		).toContain("'choices_of' takes its values from another entity's enum");
		expect(
			joined(schemaIssues(rawFixture('communication_part', (r) => (r.fields.kind.choices_from = 'k.yaml')))),
		).toContain("cannot be combined with 'choices' or 'choices_from'");
		expect(
			joined(schemaIssues(rawFixture('communication_part', (r) => (r.fields.sequence.choices_of = 'communication.kind')))),
		).toContain("'choices_of' is only valid on 'type: enum' fields");
		expect(
			joined(schemaIssues(rawFixture('communication_part', (r) => (r.fields.kind.choices_of = 'communication')))),
		).toContain("'choices_of' must be '<entity>.<field>'");
	});

	it('natural_key: true is a boolean on a unique_indexes entry', () => {
		expect(schemaIssues(rawFixture('communication'))).toEqual([]);
		expect(
			schemaIssues(rawFixture('communication', (r) => (r.unique_indexes[0].natural_key = 'yes'))),
		).not.toEqual([]);
	});

	it('there is no checks: key in this build (OQ-11)', () => {
		expect(schemaIssues(rawFixture('meeting', (r) => (r.checks = [])))).not.toEqual([]);
	});
});

describe('R1 — the discriminator names a required enum with a choice list', () => {
	it('R1: names no field', () => {
		expect(joined(schemaIssues(rawFixture('communication', (r) => (r.discriminator = 'category'))))).toContain(
			"R1 — 'communication': discriminator 'category' names no field",
		);
	});
	it('R1: is not an enum', () => {
		expect(joined(schemaIssues(rawFixture('communication', (r) => (r.discriminator = 'source'))))).toContain(
			"discriminator 'source' must be a 'type: enum' field, but it is 'type: string'",
		);
	});
	it('R1: is not required', () => {
		expect(joined(schemaIssues(rawFixture('communication', (r) => delete r.fields.kind.required)))).toContain(
			"discriminator 'kind' must be 'required: true'",
		);
	});
	it('R1: takes its choices from a file', () => {
		expect(
			joined(
				schemaIssues(
					rawFixture('communication', (r) => {
						delete r.fields.kind.choices;
						r.fields.kind.choices_from = 'kinds.yaml';
					}),
				),
			),
		).toContain("takes its choices from a file ('choices_from')");
	});
	it('R1: accepts literal choices and choices_of (the family does)', () => {
		expect(schemaIssues(rawFixture('communication'))).toEqual([]);
		expect(schemaIssues(rawFixture('communication_part'))).toEqual([]);
	});
});

describe('R3 — one level (own-file half)', () => {
	it('R3: a child declaring a discriminator', () => {
		const msg = joined(schemaIssues(rawFixture('meeting', (r) => (r.discriminator = 'kind'))));
		expect(msg).toContain("R3 — 'meeting' inherits 'communication' and also declares 'discriminator:'");
	});
});

describe('R5 — lifecycle and tenancy are declared on the base', () => {
	it('R5: tenant_scoped on a child names the base', () => {
		const msg = joined(schemaIssues(rawFixture('meeting', (r) => (r.tenant_scoped = true))));
		expect(msg).toContain("R5 — 'meeting' is a child of 'communication' and declares 'tenant_scoped:'");
		expect(msg).toContain("'communication'");
	});
	it('R5: the object form of tenant_scoped too', () => {
		expect(joined(schemaIssues(rawFixture('meeting', (r) => (r.tenant_scoped = { column: 'org_id' }))))).toContain('R5');
	});
	for (const behavior of ['timestamps', 'soft_delete', 'user_tracking', 'external_id_tracking']) {
		it(`R5: ${behavior} on a child`, () => {
			const msg = joined(schemaIssues(rawFixture('meeting', (r) => (r.behaviors = [behavior]))));
			expect(msg).toContain(`R5 — 'meeting' is a child of 'communication' and declares or implies the '${behavior}' behavior`);
		});
	}
	it('R5: a pattern that implies a lifecycle behavior counts (Integrated implies external_id_tracking)', () => {
		const msg = joined(schemaIssues(rawFixture('meeting', (r) => (r.entity.pattern = 'Integrated'))));
		expect(msg).toContain("implies the 'external_id_tracking' behavior");
	});
	it('R5: a base may declare them (the family does)', () => {
		expect(schemaIssues(rawFixture('communication'))).toEqual([]);
		expect(schemaIssues(rawFixture('communication_part'))).toEqual([]);
	});
});

describe('R9 — no EAV or junction in a family', () => {
	it('R9: eav on a child', () => {
		expect(joined(schemaIssues(rawFixture('meeting', (r) => (r.eav = true))))).toContain(
			"R9 — 'meeting' is a child of 'communication' and declares 'eav: true'",
		);
	});
	it('R9: eav on a base', () => {
		expect(joined(schemaIssues(rawFixture('communication', (r) => (r.eav = true))))).toContain(
			"R9 — 'communication' is the base of a family (discriminator 'kind') and declares 'eav: true'",
		);
	});
	it('R9: pattern Junction on a child and on a base', () => {
		expect(joined(schemaIssues(rawFixture('meeting', (r) => (r.entity.pattern = 'Junction'))))).toContain(
			"R9 — 'meeting' is a child of 'communication' and declares 'pattern: Junction'",
		);
		expect(
			joined(schemaIssues(rawFixture('communication', (r) => (r.entity.patterns = ['Activity', 'Junction'])))),
		).toContain("R9 — 'communication' is the base of a family");
	});
	it('R9: eav on an entity outside any family is untouched', () => {
		expect(schemaIssues(rawFixture('person', (r) => (r.eav = true)))).toEqual([]);
	});
});

describe('§8 — refused on a child in v1', () => {
	const cases: Array<[string, (r: Record<string, any>) => void, string]> = [
		['pattern: Integrated', (r) => (r.entity.pattern = 'Integrated'), "declares 'pattern: Integrated'"],
		['surface:', (r) => (r.entity.surface = 'mail'), "declares 'surface:'"],
		['integration:', (r) => (r.integration = { providers: {} }), "declares 'integration:'"],
		['detection:', (r) => (r.detection = {}), "declares 'detection:'"],
		['eav_value_table', (r) => (r.eav_value_table = true), "declares 'eav_value_table: true'"],
	];
	for (const [label, mutate, expected] of cases) {
		it(`a child declaring ${label}`, () => {
			const msg = joined(schemaIssues(rawFixture('meeting', mutate)));
			expect(msg).toContain("'meeting' is a child of 'communication'");
			expect(msg).toContain(expected);
		});
	}
	it('a child declaring an id field (its key is the base row id)', () => {
		expect(joined(schemaIssues(rawFixture('meeting', (r) => (r.fields.id = { type: 'uuid', required: true }))))).toContain(
			"'meeting' is a child of 'communication' and declares a field 'id'",
		);
	});
	it('a base declaring a non-uuid id', () => {
		expect(joined(schemaIssues(rawFixture('communication', (r) => (r.fields.id = { type: 'integer', required: true }))))).toContain(
			"'communication' is the base of a family and declares 'id' as 'type: integer'",
		);
	});
});

describe('R11 — the natural key', () => {
	it('R11: more than one natural_key entry', () => {
		const msg = joined(
			schemaIssues(
				rawFixture('communication', (r) => {
					r.unique_indexes.push({ fields: ['external_id'], natural_key: true, name: 'second' });
				}),
			),
		);
		expect(msg).toContain("R11 — 'communication' marks 2 unique_indexes entries 'natural_key: true'");
	});
	it('R11: a child declares none', () => {
		const msg = joined(
			schemaIssues(rawFixture('meeting', (r) => (r.unique_indexes = [{ fields: ['title'], natural_key: true }]))),
		);
		expect(msg).toContain("R11 — 'meeting' is a child of 'communication' and declares 'natural_key: true'");
	});
	it('R11: a nullable key column', () => {
		const msg = joined(
			schemaIssues(rawFixture('communication', (r) => (r.fields.external_id = { type: 'string', nullable: true }))),
		);
		expect(msg).toContain("R11 — 'communication': natural_key column 'external_id' is nullable");
	});
	it('R11: a key column the entity does not declare', () => {
		const msg = joined(schemaIssues(rawFixture('communication', (r) => (r.unique_indexes[0].fields = ['source', 'nope']))));
		expect(msg).toContain("natural_key column 'nope' is not a declared field or foreign key column");
	});
	it('R11: a partial index cannot be the conflict target', () => {
		const msg = joined(
			schemaIssues(
				rawFixture('communication', (r) => {
					r.unique_indexes[0].where = "source = 'x'";
					r.unique_indexes[0].name = 'partial_nk';
				}),
			),
		);
		expect(msg).toContain('partial index');
	});
	it('R11: an FK column counts, NOT NULL by default (the second base does)', () => {
		expect(schemaIssues(rawFixture('communication_part'))).toEqual([]);
		const msg = joined(
			schemaIssues(
				rawFixture('communication_part', (r) => {
					r.relationships.communication.nullable = true;
				}),
			),
		);
		expect(msg).toContain("natural_key column 'communication_id' is nullable");
	});
	it('R11: natural_key on an entity outside any family is legal (a single-row upsert target)', () => {
		expect(
			schemaIssues(rawFixture('person', (r) => (r.unique_indexes = [{ fields: ['name'], natural_key: true }]))),
		).toEqual([]);
	});
});

describe('generation refusal (until S2 of #875)', () => {
	it('lists the unemitted keys an entity uses', () => {
		const keys = (name: string) => unemittedInheritanceKeys(EntityDefinitionSchema.parse(rawFixture(name)));
		expect(keys('meeting')).toEqual(["'inherits:'"]);
		expect(keys('communication')).toEqual(["'discriminator:'"]);
		expect(keys('communication_participant')).toEqual([
			"'match:' on relationship 'communication'",
			"'match:' on relationship 'role'",
		]);
		expect(keys('communication_participant_role')).toEqual(["'choices_of:' on field 'kind'"]);
		expect(keys('communication_part')).toEqual(["'discriminator:'", "'match:' on relationship 'communication'", "'choices_of:' on field 'kind'"]);
	});
	it('natural_key alone is not refused: no emitter reads it', () => {
		const person = EntityDefinitionSchema.parse(rawFixture('person', (r) => (r.unique_indexes = [{ fields: ['name'], natural_key: true }])));
		expect(unemittedInheritanceKeys(person)).toEqual([]);
	});
	it('a plain entity uses none', () => {
		expect(unemittedInheritanceKeys(EntityDefinitionSchema.parse(rawFixture('email_thread')))).toEqual([]);
	});
	it('the message names the entity, the keys and S2', () => {
		const msg = notGeneratedYetMessage('meeting', ["'inherits:'"]);
		expect(msg).toContain("'meeting'");
		expect(msg).toContain("'inherits:'");
		expect(msg).toContain('not implemented until S2 of #875');
	});
});
