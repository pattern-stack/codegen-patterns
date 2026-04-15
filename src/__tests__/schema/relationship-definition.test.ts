/**
 * Relationship Definition Schema tests
 *
 * Validates the relationship YAML contract against the Zod schema.
 * Uses fixture files from test/fixtures/relationships/ as integration tests.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import {
	RelationshipDefinitionSchema,
	deriveRelationshipFKColumns,
	deriveTableName,
	collectTypeNames,
	collectInverseNames,
	deriveUniqueConstraint,
	getReservedColumnNames,
	type RelationshipConfig,
} from '../../schema/relationship-definition.schema';

// ============================================================================
// Helpers
// ============================================================================

function loadFixture(name: string) {
	const filePath = resolve(__dirname, `../../../test/fixtures/relationships/${name}`);
	const content = readFileSync(filePath, 'utf-8');
	return parseYaml(content);
}

// ============================================================================
// Fixture Validation
// ============================================================================

describe('relationship fixtures validate against schema', () => {
	const fixtures = [
		'person_organization.yaml',
		'person_opportunity_role.yaml',
		'person_person.yaml',
		'organization_hierarchy.yaml',
		'engagement_participant.yaml',
		'engagement_opportunity.yaml',
	];

	for (const fixture of fixtures) {
		it(`validates ${fixture}`, () => {
			const data = loadFixture(fixture);
			const result = RelationshipDefinitionSchema.safeParse(data);
			if (!result.success) {
				console.error(`Validation errors for ${fixture}:`, result.error.errors);
			}
			expect(result.success).toBe(true);
		});
	}
});

// ============================================================================
// Schema Shape
// ============================================================================

describe('relationship config block', () => {
	const minimal = {
		relationship: {
			name: 'engagement_opportunity',
			from: 'engagement',
			to: 'opportunity',
		},
	};

	it('accepts minimal definition (no types, no fields, no queries)', () => {
		const result = RelationshipDefinitionSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});

	it('defaults temporal to true', () => {
		const result = RelationshipDefinitionSchema.parse(minimal);
		expect(result.relationship.temporal).toBe(true);
	});

	it('defaults sourced to true', () => {
		const result = RelationshipDefinitionSchema.parse(minimal);
		expect(result.relationship.sourced).toBe(true);
	});

	it('rejects invalid name format', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: { name: 'PersonOrg', from: 'person', to: 'organization' },
		});
		expect(result.success).toBe(false);
	});

	it('rejects unknown top-level keys (strict)', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			...minimal,
			unknown_key: true,
		});
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Types: Simple List vs Object Map
// ============================================================================

describe('relationship types', () => {
	it('accepts simple list form', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'person_org',
				from: 'person',
				to: 'organization',
				types: ['employed_by', 'advises', 'board_member'],
			},
		});
		expect(result.success).toBe(true);
	});

	it('accepts object map form with inverse', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'person_person',
				from: 'person',
				to: 'person',
				types: {
					reporting: { inverse: 'management' },
					network: { bidirectional: true },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it('rejects object map type with multiple direction keys', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test',
				from: 'a',
				to: 'a',
				types: {
					bad: { inverse: 'foo', bidirectional: true },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects object map type with zero direction keys', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test',
				from: 'a',
				to: 'a',
				types: {
					bad: {},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects simple list for self-referential relationships', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'person_person',
				from: 'person',
				to: 'person',
				types: ['reporting', 'network'],
			},
		});
		expect(result.success).toBe(false);
	});

	it('allows self-referential without types (untyped junction)', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'person_person',
				from: 'person',
				to: 'person',
			},
		});
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// Helper Functions
// ============================================================================

// ============================================================================
// Reserved Column Validation
// ============================================================================

describe('reserved column name collision', () => {
	it('rejects fields that collide with auto-generated columns', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test_rel',
				from: 'person',
				to: 'organization',
				types: ['employed_by'],
				temporal: true,
				sourced: true,
			},
			fields: {
				type: { type: 'string' }, // collides with auto-generated type enum
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects fields colliding with temporal columns', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test_rel',
				from: 'person',
				to: 'organization',
				temporal: true,
			},
			fields: {
				valid_from: { type: 'date' },
			},
		});
		expect(result.success).toBe(false);
	});

	it('allows valid_from as field when temporal is false', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test_rel',
				from: 'person',
				to: 'organization',
				temporal: false,
			},
			fields: {
				valid_from: { type: 'date' },
			},
		});
		expect(result.success).toBe(true);
	});

	it('rejects fields colliding with FK columns', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test_rel',
				from: 'person',
				to: 'organization',
			},
			fields: {
				person_id: { type: 'uuid' },
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects fields colliding with self-ref FK columns', () => {
		const result = RelationshipDefinitionSchema.safeParse({
			relationship: {
				name: 'test_rel',
				from: 'person',
				to: 'person',
			},
			fields: {
				from_person_id: { type: 'uuid' },
			},
		});
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Helper Functions
// ============================================================================

describe('deriveRelationshipFKColumns', () => {
	it('cross-type uses entity_id naming', () => {
		const result = deriveRelationshipFKColumns({
			name: 'person_organization',
			from: 'person',
			to: 'organization',
			temporal: true,
			sourced: true,
		});
		expect(result).toEqual({
			fromColumn: 'person_id',
			toColumn: 'organization_id',
		});
	});

	it('self-referential uses from_/to_ prefix', () => {
		const result = deriveRelationshipFKColumns({
			name: 'person_person',
			from: 'person',
			to: 'person',
			temporal: true,
			sourced: true,
		});
		expect(result).toEqual({
			fromColumn: 'from_person_id',
			toColumn: 'to_person_id',
		});
	});
});

describe('deriveTableName', () => {
	it('uses explicit table name when provided', () => {
		expect(
			deriveTableName({
				name: 'person_org',
				table: 'person_organizations',
				from: 'person',
				to: 'organization',
				temporal: true,
				sourced: true,
			}),
		).toBe('person_organizations');
	});

	it('falls back to name + s', () => {
		expect(
			deriveTableName({
				name: 'engagement_opportunity',
				from: 'engagement',
				to: 'opportunity',
				temporal: true,
				sourced: true,
			}),
		).toBe('engagement_opportunitys');
	});
});

describe('collectTypeNames', () => {
	it('handles simple list', () => {
		expect(collectTypeNames(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
	});

	it('handles object map', () => {
		const types = {
			reporting: { inverse: 'management' },
			network: { bidirectional: true },
		};
		expect(collectTypeNames(types)).toEqual(['reporting', 'network']);
	});

	it('handles undefined', () => {
		expect(collectTypeNames(undefined)).toEqual([]);
	});
});

describe('collectInverseNames', () => {
	it('extracts inverse names from object map', () => {
		const types = {
			reporting: { inverse: 'management' },
			network: { bidirectional: true },
			vendor_of: { inverse: 'customer_of' },
		};
		expect(collectInverseNames(types)).toEqual(['management', 'customer_of']);
	});

	it('returns empty for simple list', () => {
		expect(collectInverseNames(['a', 'b'])).toEqual([]);
	});
});

describe('deriveUniqueConstraint', () => {
	it('typed + temporal: [from, to, type, valid_from]', () => {
		const result = deriveUniqueConstraint({
			name: 'person_organization',
			from: 'person',
			to: 'organization',
			types: ['employed_by'],
			temporal: true,
			sourced: true,
		});
		expect(result).toEqual([
			'person_id',
			'organization_id',
			'type',
			'valid_from',
		]);
	});

	it('typed + not temporal: [from, to, type]', () => {
		const result = deriveUniqueConstraint({
			name: 'engagement_participant',
			from: 'engagement',
			to: 'person',
			types: ['organizer', 'attendee'],
			temporal: false,
			sourced: true,
		});
		expect(result).toEqual(['engagement_id', 'person_id', 'type']);
	});

	it('untyped: [from, to]', () => {
		const result = deriveUniqueConstraint({
			name: 'test',
			from: 'a',
			to: 'b',
			temporal: true,
			sourced: true,
		});
		expect(result).toEqual(['a_id', 'b_id']);
	});

	it('respects unique_on override', () => {
		const result = deriveUniqueConstraint({
			name: 'test',
			from: 'person',
			to: 'organization',
			types: ['employed_by'],
			temporal: true,
			sourced: true,
			unique_on: ['person_id', 'organization_id', 'type'],
		});
		expect(result).toEqual(['person_id', 'organization_id', 'type']);
	});

	it('self-referential uses from_/to_ prefix', () => {
		const result = deriveUniqueConstraint({
			name: 'person_person',
			from: 'person',
			to: 'person',
			types: { reporting: { inverse: 'management' } },
			temporal: true,
			sourced: true,
		});
		expect(result).toEqual([
			'from_person_id',
			'to_person_id',
			'type',
			'valid_from',
		]);
	});
});
