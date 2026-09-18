/**
 * Unit tests for `composePatterns` + `detectMethodCollisions` (ADR-041).
 *
 * These pin the two rulings that changed behaviour rather than added it:
 * spine selection is by contribution and not by position (§2), and a method
 * name a capability contributes is checked at generation time rather than left
 * to the consumer's compiler (§4).
 */

import { describe, test, expect } from 'bun:test';

import {
	composePatterns,
	declaredPatternNames,
	detectMethodCollisions,
} from '../../patterns/compose.ts';
import {
	defineCapabilityPattern,
	definePattern,
	type EntityPatternDefinition,
} from '../../patterns/pattern-definition.ts';

// A self-contained registry — these tests never touch the global one, so they
// cannot be perturbed by (or perturb) the library registration side effects.
const BasePattern = definePattern({
	name: 'Base',
	repositoryClass: 'BaseRepository',
	serviceClass: 'BaseService',
});
const IntegratedPattern = definePattern({
	name: 'Integrated',
	extends: ['Base'],
	repositoryClass: 'IntegratedEntityRepository',
	serviceClass: 'IntegratedEntityService',
});
const ActivityPattern = definePattern({
	name: 'Activity',
	extends: ['Base'],
	repositoryClass: 'ActivityEntityRepository',
	serviceClass: 'ActivityEntityService',
});
const ColumnsOnlyPattern = definePattern({
	name: 'ColumnsOnly',
	columns: [{ name: 'rank', type: 'integer' }],
});
const GroupPattern = defineCapabilityPattern({
	name: 'Group',
	kind: 'capability',
	mixin: 'WithGroup',
	mixinImport: '@shared/base-classes/with-group',
	forwarderMethods: ['members'],
});
const IndividualPattern = defineCapabilityPattern({
	name: 'Individual',
	kind: 'capability',
	mixin: 'WithIndividual',
	mixinImport: '@shared/base-classes/with-individual',
	forwarderMethods: ['principal'],
});

const REGISTRY = new Map<string, EntityPatternDefinition>([
	['Base', BasePattern],
	['Integrated', IntegratedPattern],
	['Activity', ActivityPattern],
	['ColumnsOnly', ColumnsOnlyPattern],
	['Group', GroupPattern],
	['Individual', IndividualPattern],
]);
const lookup = (name: string): EntityPatternDefinition | undefined =>
	REGISTRY.get(name);

describe('declaredPatternNames', () => {
	test('reads the single `pattern:` form', () => {
		expect(declaredPatternNames({ pattern: 'Integrated' })).toEqual(['Integrated']);
	});

	test('reads the `patterns:` array form, order preserved', () => {
		expect(declaredPatternNames({ patterns: ['Group', 'Integrated'] })).toEqual([
			'Group',
			'Integrated',
		]);
	});

	test('a pattern-free entity declares nothing', () => {
		expect(declaredPatternNames({})).toEqual([]);
	});
});

describe('composePatterns — spine selection (ADR-041 §2)', () => {
	test('no declared pattern falls back to the library Base spine', () => {
		const composed = composePatterns([], lookup);
		expect(composed.spineName).toBe('Base');
		expect(composed.capabilities).toEqual([]);
		expect(composed.errors).toEqual([]);
	});

	test('one inheritable base is the spine', () => {
		const composed = composePatterns(['Integrated'], lookup);
		expect(composed.spineName).toBe('Integrated');
		expect(composed.spine?.repositoryClass).toBe('IntegratedEntityRepository');
	});

	test('the spine is found regardless of position — the rule is not `patterns[0]`', () => {
		const first = composePatterns(['Group', 'Integrated', 'Individual'], lookup);
		const last = composePatterns(['Individual', 'Group', 'Integrated'], lookup);
		expect(first.spineName).toBe('Integrated');
		expect(last.spineName).toBe('Integrated');
		expect(first.errors).toEqual([]);
		expect(last.errors).toEqual([]);
	});

	test('a pattern contributing only columns is not a spine candidate', () => {
		const composed = composePatterns(['ColumnsOnly'], lookup);
		expect(composed.spineName).toBe('Base');
		expect(composed.errors).toEqual([]);
	});

	test('a declared ancestor of another candidate is redundant, not a competitor', () => {
		const composed = composePatterns(['Base', 'Integrated'], lookup);
		expect(composed.spineName).toBe('Integrated');
		expect(composed.errors).toEqual([]);
	});

	test('two inheritable bases is a hard error naming both', () => {
		const composed = composePatterns(['Integrated', 'Activity'], lookup, {
			entity: 'message',
		});
		expect(composed.errors).toHaveLength(1);
		expect(composed.errors[0]?.code).toBe('pattern_multiple_spines');
		expect(composed.errors[0]?.message).toContain('Integrated, Activity');
		expect(composed.errors[0]?.message).toContain("kind: 'capability'");
		expect(composed.errors[0]?.message).toContain("Entity 'message'");
	});

	test('reordering two spine bases reports the same error', () => {
		const a = composePatterns(['Integrated', 'Activity'], lookup);
		const b = composePatterns(['Activity', 'Integrated'], lookup);
		expect(a.errors).toHaveLength(1);
		expect(b.errors).toHaveLength(1);
	});

	test('unknown names are reported back, not silently dropped', () => {
		const composed = composePatterns(['Nope', 'Integrated'], lookup);
		expect(composed.unknown).toEqual(['Nope']);
		expect(composed.spineName).toBe('Integrated');
	});
});

describe('composePatterns — capability layering', () => {
	test('capabilities keep declaration order (rightmost ends up outermost at emit)', () => {
		const composed = composePatterns(
			['Group', 'Integrated', 'Individual'],
			lookup,
		);
		expect(composed.capabilities.map((c) => c.name)).toEqual([
			'Group',
			'Individual',
		]);
	});

	test('capabilities never become the spine', () => {
		const composed = composePatterns(['Group', 'Individual'], lookup);
		expect(composed.spineName).toBe('Base');
		expect(composed.capabilities).toHaveLength(2);
		expect(composed.errors).toEqual([]);
	});
});

describe('detectMethodCollisions (ADR-041 §4)', () => {
	const cap = (source: string, methods: string[]) => ({
		source,
		methods,
		capability: true,
	});
	const generated = (source: string, methods: string[]) => ({
		source,
		methods,
		capability: false,
	});

	test('two capabilities contributing the same name collide', () => {
		const errors = detectMethodCollisions([
			cap("capability 'A'", ['members']),
			cap("capability 'B'", ['members']),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe('pattern_method_collision');
		expect(errors[0]?.message).toContain("'members'");
	});

	test('a capability colliding with a generated query method is reported', () => {
		const errors = detectMethodCollisions([
			cap("capability 'A'", ['findByEmail']),
			generated('`queries:`', ['findByEmail']),
		]);
		expect(errors).toHaveLength(1);
	});

	test('the pre-existing queries × FK overlap is NOT reported', () => {
		// Both are codegen-generated and the precedence rule that resolves them
		// is documented in repository.ejs.t. Reporting it would break entities
		// that work today.
		const errors = detectMethodCollisions([
			generated('`queries:`', ['findByAccountId']),
			generated('a relationship forwarder', ['findByAccountId']),
		]);
		expect(errors).toEqual([]);
	});

	test('distinct vocabularies produce no error', () => {
		const errors = detectMethodCollisions([
			cap("capability 'A'", ['members']),
			cap("capability 'B'", ['principal']),
			generated('`queries:`', ['findByEmail']),
		]);
		expect(errors).toEqual([]);
	});

	test('one name colliding across three vocabularies reports once, naming all', () => {
		const errors = detectMethodCollisions([
			cap("capability 'A'", ['members']),
			cap("capability 'B'", ['members']),
			generated('`queries:`', ['members']),
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("capability 'A'");
		expect(errors[0]?.message).toContain("capability 'B'");
		expect(errors[0]?.message).toContain('`queries:`');
	});
});
