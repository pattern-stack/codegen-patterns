/**
 * EAV under `wiring: pattern-stack` (PW-EAV): an EAV entity generates (the refusal PW-3a had is lifted), except on a
 * family child, whose EAV templates drop the base's repository and type the child row (the same gap under Nest), so
 * that combination is refused by name.
 */
import { describe, expect, it } from 'bun:test';

import { backendLocalsFor } from '../derived/_render';
import type { EntityDefinitionInput } from '../../derived/api/entity';

const def = (d: Record<string, unknown>): EntityDefinitionInput => d as unknown as EntityDefinitionInput;
const PATTERN_STACK = { target: { database: 'postgres', orm: 'drizzle', wiring: 'pattern-stack', http: 'none' } };

const fieldDefinition = def({
	entity: { name: 'field_definition', plural: 'field_definitions' },
	fields: { entity_type: { type: 'string', required: true }, key: { type: 'string', required: true } },
});
const fieldValue = def({
	entity: { name: 'field_value', plural: 'field_values', pattern: 'Metadata' },
	fields: {
		entity_type: { type: 'string', required: true },
		entity_id: { type: 'uuid', required: true },
		field_definition_id: { type: 'uuid', required: true },
		user_id: { type: 'uuid', required: true },
		value: { type: 'json', required: true },
	},
	eav_value_table: true,
	eav_definition_table: 'field_definition',
});
const lead = def({
	entity: { name: 'lead', plural: 'leads' },
	fields: { name: { type: 'string', required: true }, user_id: { type: 'uuid', required: true } },
	eav: true,
});
const parcel = def({
	entity: { name: 'parcel', plural: 'parcels' },
	discriminator: 'kind',
	fields: { kind: { type: 'enum', choices: ['crate', 'loose'], required: true }, user_id: { type: 'uuid', required: true } },
});
const crate = def({ entity: { name: 'crate', plural: 'crates' }, inherits: 'parcel', eav: true, fields: { label: { type: 'string' } } });

const set = { entities: [lead, fieldValue, fieldDefinition, parcel, crate], junctions: [] };

describe('EAV under wiring: pattern-stack', () => {
	it('wires an EAV entity: its repository, service and create / update use cases take FieldValueService', () => {
		const parts = backendLocalsFor(set, 'lead', PATTERN_STACK).patternStackWiringParts as {
			eav: { serviceClass: string } | null;
			useCases: { kind: string }[];
		};
		expect(parts.eav?.serviceClass).toBe('FieldValueService');
		expect(parts.useCases.map((u) => u.kind)).toEqual(expect.arrayContaining(['find_by_id_with_fields', 'list_with_fields']));
	});

	it("wires the value table's definition repository", () => {
		const parts = backendLocalsFor(set, 'field_value', PATTERN_STACK).patternStackWiringParts as {
			eavDefinition: { property: string; repositoryClass: string } | null;
		};
		expect(parts.eavDefinition).toMatchObject({ property: 'fieldDefinitionRepo', repositoryClass: 'FieldDefinitionRepository' });
	});

	it('refuses EAV on an entity that inherits:, by name', () => {
		expect(() => backendLocalsFor(set, 'crate', PATTERN_STACK)).toThrow(/EAV \(`eav: true`\) on an entity that `inherits:`/);
	});
});
