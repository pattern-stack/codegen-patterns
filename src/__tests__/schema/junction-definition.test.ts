/**
 * Junction Definition Schema tests.
 *
 * Validates the junction YAML contract against the Zod schema and the
 * `detectYamlType` discriminator. Uses fixtures under
 * `test/fixtures/junctions/`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
	JunctionDefinitionSchema,
	safeValidateJunctionDefinition,
} from '../../schema/junction-definition.schema';
import { detectYamlType, loadJunctionFromYaml } from '../../utils/yaml-loader';

// ============================================================================
// Helpers
// ============================================================================

const FIXTURE_ROOT = resolve(__dirname, '../../../test/fixtures/junctions');

function loadFixture(name: string): unknown {
	const filePath = resolve(FIXTURE_ROOT, name);
	const content = readFileSync(filePath, 'utf-8');
	return parseYaml(content);
}

function fixturePath(name: string): string {
	return resolve(FIXTURE_ROOT, name);
}

// ============================================================================
// Valid fixtures
// ============================================================================

describe('junction fixtures validate against schema', () => {
	const fixtures = ['opportunity_contact.yaml', 'opportunity_activity.yaml'];

	for (const fixture of fixtures) {
		it(`validates ${fixture}`, () => {
			const data = loadFixture(fixture);
			const result = JunctionDefinitionSchema.safeParse(data);
			if (!result.success) {
				console.error(`Validation errors for ${fixture}:`, result.error.errors);
			}
			expect(result.success).toBe(true);
		});
	}

	it('intra-domain pair (opportunity, contact) parses to the documented shape', () => {
		const data = loadFixture('opportunity_contact.yaml');
		const parsed = JunctionDefinitionSchema.parse(data);
		expect(parsed.pattern).toBe('Junction');
		expect(parsed.between).toEqual(['opportunity', 'contact']);
		expect(parsed.temporal).toBe(true);
		expect(parsed.sourced).toBe(true);
		expect(parsed.fields).toBeDefined();
	});

	it('cross-domain pair (opportunity, activity) parses cleanly', () => {
		const data = loadFixture('opportunity_activity.yaml');
		const parsed = JunctionDefinitionSchema.parse(data);
		expect(parsed.between).toEqual(['opportunity', 'activity']);
	});
});

// ============================================================================
// Defaults
// ============================================================================

describe('junction schema defaults', () => {
	const minimal = {
		pattern: 'Junction' as const,
		between: ['opportunity', 'contact'] as [string, string],
	};

	it('accepts minimal definition (no fields, no queries)', () => {
		const result = JunctionDefinitionSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});

	it('defaults temporal to true', () => {
		const parsed = JunctionDefinitionSchema.parse(minimal);
		expect(parsed.temporal).toBe(true);
	});

	it('defaults sourced to true', () => {
		const parsed = JunctionDefinitionSchema.parse(minimal);
		expect(parsed.sourced).toBe(true);
	});

	it('preserves explicit temporal: false', () => {
		const parsed = JunctionDefinitionSchema.parse({ ...minimal, temporal: false });
		expect(parsed.temporal).toBe(false);
	});

	it('preserves explicit sourced: false', () => {
		const parsed = JunctionDefinitionSchema.parse({ ...minimal, sourced: false });
		expect(parsed.sourced).toBe(false);
	});
});

// ============================================================================
// Reject paths
// ============================================================================

describe('junction schema rejects malformed input', () => {
	it('rejects pattern value other than "Junction"', () => {
		const result = JunctionDefinitionSchema.safeParse({
			pattern: 'Synced',
			between: ['opportunity', 'contact'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects between of length 1', () => {
		const result = JunctionDefinitionSchema.safeParse({
			pattern: 'Junction',
			between: ['opportunity'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects between of length 3 (fixture)', () => {
		const data = loadFixture('invalid/bad-between-arity.yaml');
		const result = JunctionDefinitionSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it('rejects non-snake_case entity names in between', () => {
		const result = JunctionDefinitionSchema.safeParse({
			pattern: 'Junction',
			between: ['Opportunity', 'contact'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects same-endpoint pair (fixture)', () => {
		const data = loadFixture('invalid/same-endpoint.yaml');
		const result = JunctionDefinitionSchema.safeParse(data);
		expect(result.success).toBe(false);
		const messages = result.success
			? []
			: result.error.errors.map((e) => e.message).join(' | ');
		expect(messages).toMatch(/distinct/);
	});

	it('rejects fields: that redeclare a BaseJunctionFields column (fixture)', () => {
		const data = loadFixture('invalid/collides-base-field.yaml');
		const result = JunctionDefinitionSchema.safeParse(data);
		expect(result.success).toBe(false);
		const messages = result.success
			? []
			: result.error.errors.map((e) => e.message).join(' | ');
		expect(messages).toMatch(/BaseJunctionFields/);
	});

	it('rejects unknown top-level keys (role_enum_ref indirection, fixture)', () => {
		// The "shared role enum" reject-path: there is no syntax for
		// cross-pairing enum reuse. `.strict()` rejects the unknown key.
		const data = loadFixture('invalid/shared-role-enum-ref.yaml');
		const result = JunctionDefinitionSchema.safeParse(data);
		expect(result.success).toBe(false);
	});

	it('rejects unknown top-level keys (strict object)', () => {
		const result = JunctionDefinitionSchema.safeParse({
			pattern: 'Junction',
			between: ['opportunity', 'contact'],
			arbitrary_extension: true,
		});
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// safeValidateJunctionDefinition helper
// ============================================================================

describe('safeValidateJunctionDefinition', () => {
	it('returns success=true for a valid definition', () => {
		const data = loadFixture('opportunity_contact.yaml');
		const result = safeValidateJunctionDefinition(data);
		expect(result.success).toBe(true);
		expect(result.data?.between).toEqual(['opportunity', 'contact']);
	});

	it('returns success=false for an invalid definition', () => {
		const data = loadFixture('invalid/bad-between-arity.yaml');
		const result = safeValidateJunctionDefinition(data);
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});

// ============================================================================
// detectYamlType / loadJunctionFromYaml
// ============================================================================

describe('detectYamlType', () => {
	it('returns "junction" for a junction fixture', () => {
		expect(detectYamlType(fixturePath('opportunity_contact.yaml'))).toBe(
			'junction',
		);
	});

	it('returns "entity" for an entity fixture (unaffected by junction routing)', () => {
		const entityFixture = resolve(
			__dirname,
			'../../../test/fixtures/opportunity.yaml',
		);
		expect(detectYamlType(entityFixture)).toBe('entity');
	});

	it('returns "relationship" for a relationship fixture (unaffected by junction routing)', () => {
		const relFixture = resolve(
			__dirname,
			'../../../test/fixtures/relationships/person_organization.yaml',
		);
		expect(detectYamlType(relFixture)).toBe('relationship');
	});
});

describe('loadJunctionFromYaml', () => {
	it('loads + validates a junction file end-to-end', () => {
		const result = loadJunctionFromYaml(fixturePath('opportunity_contact.yaml'));
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.definition.between).toEqual(['opportunity', 'contact']);
			expect(result.filePath).toBe(fixturePath('opportunity_contact.yaml'));
		}
	});

	it('reports a structured failure for an invalid junction file', () => {
		const result = loadJunctionFromYaml(
			fixturePath('invalid/bad-between-arity.yaml'),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.details?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('reports file-not-found as a structured failure', () => {
		const result = loadJunctionFromYaml(fixturePath('does-not-exist.yaml'));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toMatch(/File not found/);
		}
	});
});

// ============================================================================
// Coexistence with relationships:
// ============================================================================

describe('coexistence with the existing relationships: block', () => {
	it('a junction file and a relationship file load to independent definitions', () => {
		// Loads an existing relationship fixture (person_organization) and a
		// junction fixture (opportunity_contact). Both must parse cleanly
		// against their own schemas — the registry-side coexistence point
		// is that the two surfaces live on disjoint top-level keys, so
		// neither schema's `.strict()` rejects the other's shape.
		const junctionPath = fixturePath('opportunity_contact.yaml');
		const relPath = resolve(
			__dirname,
			'../../../test/fixtures/relationships/person_organization.yaml',
		);

		const junctionResult = loadJunctionFromYaml(junctionPath);
		expect(junctionResult.success).toBe(true);

		const relRaw = parseYaml(readFileSync(relPath, 'utf-8'));
		// Don't import the relationship schema directly — go through
		// `detectYamlType` to assert the discriminators don't collide.
		expect(detectYamlType(relPath)).toBe('relationship');
		expect(detectYamlType(junctionPath)).toBe('junction');
		expect(typeof relRaw).toBe('object');
	});
});
