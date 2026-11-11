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

	it('defaults expose_on_parent to { left: true, right: true } when omitted', () => {
		const parsed = JunctionDefinitionSchema.parse(minimal);
		expect(parsed.expose_on_parent).toEqual({ left: true, right: true });
	});

	it('accepts expose_on_parent: { left: false } and fills right default', () => {
		const parsed = JunctionDefinitionSchema.parse({
			...minimal,
			expose_on_parent: { left: false },
		});
		expect(parsed.expose_on_parent).toEqual({ left: false, right: true });
	});

	it('accepts expose_on_parent: { left: false, right: false } (junction-only)', () => {
		const parsed = JunctionDefinitionSchema.parse({
			...minimal,
			expose_on_parent: { left: false, right: false },
		});
		expect(parsed.expose_on_parent).toEqual({ left: false, right: false });
	});
});

// ============================================================================
// Reject paths
// ============================================================================

describe('junction schema rejects malformed input', () => {
	it('rejects pattern value other than "Junction"', () => {
		const result = JunctionDefinitionSchema.safeParse({
			pattern: 'Integrated',
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
// Payload fields are entity fields (#740, #690, dogfood #7/#8)
// ============================================================================

describe('junction payload fields parse against the entity field schema', () => {
	const parse = (extra: Record<string, unknown>) =>
		JunctionDefinitionSchema.safeParse({
			pattern: 'Junction',
			between: ['opportunity', 'contact'],
			...extra,
		});
	const messages = (r: ReturnType<typeof parse>) =>
		r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

	it('rejects `values:` on a role — the key is `choices:` (#690)', () => {
		const r = parse({ fields: { role: { type: 'enum', values: ['a'] } } });
		expect(r.success).toBe(false);
	});

	it('accepts a role without choices as an ordinary column (dogfood #7)', () => {
		const r = parse({ fields: { role: { type: 'string' } } });
		expect(r.success).toBe(true);
	});

	it('rejects a nullable identity role — it is part of the composite key', () => {
		const r = parse({ fields: { role: { type: 'enum', choices: ['a'], nullable: true } } });
		expect(messages(r)).toContainEqual(expect.stringContaining('fields.role.nullable'));
	});

	it('accepts the redundant nullable: false on an identity role', () => {
		expect(
			parse({ fields: { role: { type: 'enum', choices: ['a'], nullable: false } } }).success,
		).toBe(true);
	});

	it('applies the entity nullability rule (nullable: false needs a default)', () => {
		expect(parse({ fields: { n: { type: 'integer', nullable: false } } }).success).toBe(false);
		expect(parse({ fields: { n: { type: 'integer', nullable: false, default: 0 } } }).success).toBe(true);
	});

	it('rejects choices_from and entity_ref, which the junction template cannot render', () => {
		expect(parse({ fields: { k: { type: 'enum', choices_from: 'k.yaml' } } }).success).toBe(false);
		expect(
			parse({ fields: { k: { type: 'entity_ref', allowed_types: ['contact'] } } }).success,
		).toBe(false);
	});

	it('defaults is_primary and timestamps to true; both opt out', () => {
		const d = JunctionDefinitionSchema.parse({ pattern: 'Junction', between: ['a', 'b'] });
		expect(d.is_primary).toBe(true);
		expect(d.timestamps).toBe(true);
		const o = JunctionDefinitionSchema.parse({
			pattern: 'Junction',
			between: ['a', 'b'],
			is_primary: false,
			timestamps: false,
		});
		expect(o.is_primary).toBe(false);
		expect(o.timestamps).toBe(false);
	});

	it('reserves created_at / updated_at only while timestamps are emitted', () => {
		const field = { created_at: { type: 'datetime' } };
		expect(messages(parse({ fields: field }))).toContainEqual(
			expect.stringContaining("set 'timestamps: false'"),
		);
		expect(parse({ timestamps: false, fields: field }).success).toBe(true);
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
			'../../../test/fixtures/entities/opportunity.yaml',
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
