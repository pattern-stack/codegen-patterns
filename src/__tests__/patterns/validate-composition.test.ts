/**
 * Unit tests for `validatePatternComposition`.
 * Every row of the ADR-031 composition rules table has a dedicated case.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { z } from 'zod';

import type {
	AnalysisIssue,
	ParsedEntity,
	ParsedField,
} from '../../analyzer/types.ts';
import {
	_resetRegistryForTests,
	registerLibraryPattern,
} from '../../patterns/registry.ts';
import {
	validatePatternComposition,
} from '../../patterns/validate-composition.ts';

// Ensure library patterns are pre-registered (side-effect on barrel import).
import '../../patterns/index.ts';

// Several describe blocks below register synthetic library patterns
// (Prioritized, Ranked, MethodA, CrmEntity, etc.) via the `beforeEach` +
// `registerLibraryPattern` dance. Once this file finishes, re-register
// the canonical five library patterns so any test file that runs after
// us in the same Bun process sees the unchanged library registry.
import {
	ActivityPattern,
	BasePattern,
	MetadataPattern,
	IntegratedPattern,
	LIBRARY_PATTERN_DEFINITIONS,
} from '../../patterns/library/index.ts';

afterAll(() => {
	_resetRegistryForTests({ includeLibrary: true });
	for (const p of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(p);
});

// ============================================================================
// Test helpers
// ============================================================================

function makeEntity(partial: Partial<ParsedEntity> & { name: string }): ParsedEntity {
	return {
		name: partial.name,
		plural: partial.plural ?? `${partial.name}s`,
		table: partial.table ?? `${partial.name}s`,
		pattern: partial.pattern,
		patterns: partial.patterns,
		patternConfig: partial.patternConfig,
		expose: partial.expose ?? ['repository', 'rest', 'trpc'],
		folderStructure: 'nested',
		fields: partial.fields ?? new Map<string, ParsedField>(),
		relationships: new Map(),
		behaviors: partial.behaviors ?? [],
		queries: undefined,
		sourcePath: `/fake/${partial.name}.yaml`,
	};
}

function fieldMap(names: string[]): Map<string, ParsedField> {
	const m = new Map<string, ParsedField>();
	for (const n of names) {
		m.set(n, {
			name: n,
			type: 'string',
			required: false,
			nullable: true,
			unique: false,
			index: false,
			constraints: {},
			ui: {},
		});
	}
	return m;
}

function errors(issues: AnalysisIssue[]): AnalysisIssue[] {
	return issues.filter((i) => i.severity === 'error');
}

function warnings(issues: AnalysisIssue[]): AnalysisIssue[] {
	return issues.filter((i) => i.severity === 'warning');
}

// ============================================================================
// Base case
// ============================================================================

describe('validatePatternComposition — base cases', () => {
	test('entity with no patterns returns no issues', () => {
		const entity = makeEntity({ name: 'plain' });
		expect(validatePatternComposition(entity)).toEqual([]);
	});

	test('library pattern Integrated with no config is valid', () => {
		const entity = makeEntity({ name: 'contact', pattern: 'Integrated' });
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: pattern referenced in YAML but not in the registry → error
// ============================================================================

describe('validatePatternComposition — unknown pattern', () => {
	test('single unknown pattern surfaces one error', () => {
		const entity = makeEntity({ name: 'ghost', pattern: 'DoesNotExist' });
		const issues = validatePatternComposition(entity);
		const errs = errors(issues);
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_unknown');
		expect(errs[0]!.entity).toBe('ghost');
		expect(errs[0]!.message).toMatch(/Unknown pattern 'DoesNotExist'/);
	});

	test('unknown pattern in patterns[] surfaces per-name', () => {
		const entity = makeEntity({
			name: 'ghost',
			patterns: ['Integrated', 'DoesNotExist', 'AlsoMissing'],
		});
		const errs = errors(validatePatternComposition(entity));
		const unknownTypes = errs.filter((e) => e.type === 'pattern_unknown');
		expect(unknownTypes.length).toBe(2);
		expect(unknownTypes.map((e) => e.message)).toEqual([
			expect.stringMatching(/DoesNotExist/) as unknown as string,
			expect.stringMatching(/AlsoMissing/) as unknown as string,
		]);
	});
});

// ============================================================================
// Row: column conflict between two patterns → error
// ============================================================================

describe('validatePatternComposition — column conflicts', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		// Register two synthetic patterns that both contribute `priority`.
		registerLibraryPattern({
			name: 'Prioritized',
			columns: [{ name: 'priority', type: 'integer' }],
		});
		registerLibraryPattern({
			name: 'Ranked',
			columns: [
				{ name: 'priority', type: 'integer' }, // same column name — should conflict
				{ name: 'rank', type: 'integer' },
			],
		});
		// Keep a conflict-free pattern too
		registerLibraryPattern({
			name: 'Flagged',
			columns: [{ name: 'flag', type: 'boolean' }],
		});
	});

	test('two patterns contributing the same column → error naming both', () => {
		const entity = makeEntity({
			name: 'item',
			patterns: ['Prioritized', 'Ranked'],
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_column_conflict');
		expect(errs[0]!.message).toMatch(/Pattern 'Ranked' contributes column 'priority'/);
		expect(errs[0]!.message).toMatch(/pattern 'Prioritized'/);
	});

	test('pattern column conflicts with entity field → error', () => {
		const entity = makeEntity({
			name: 'item',
			pattern: 'Prioritized',
			fields: fieldMap(['priority']),
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_column_conflict');
		expect(errs[0]!.message).toMatch(/conflicts with entity field 'priority'/);
	});

	test('pattern column conflicts with behavior field → error', () => {
		// Register a pattern that collides with the `external_id_tracking`
		// behavior's `external_id` field (which IntegratedPattern implies).
		registerLibraryPattern({
			name: 'ExternalIdSquatter',
			columns: [{ name: 'external_id', type: 'varchar(255)' }],
		});
		const entity = makeEntity({
			name: 'item',
			pattern: 'ExternalIdSquatter',
			behaviors: ['external_id_tracking'],
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_column_conflict');
		expect(errs[0]!.message).toMatch(/conflicts with behavior field 'external_id'/);
	});

	test('non-conflicting patterns compose cleanly', () => {
		const entity = makeEntity({
			name: 'item',
			patterns: ['Prioritized', 'Flagged'],
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: same implied behavior across patterns → silent dedup (no error)
// ============================================================================

describe('validatePatternComposition — implied behavior dedup', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		registerLibraryPattern({
			name: 'IntegratedA',
			repositoryClass: 'IntegratedARepo',
			impliedBehaviors: ['external_id_tracking'],
		});
		registerLibraryPattern({
			// A capability, not a second domain pattern: two inheritable bases on
			// one entity is a hard error since ADR-041. Dedup across a spine and a
			// capability is the shape that exists now.
			name: 'IntegratedB',
			kind: 'capability',
			mixin: 'WithIntegratedB',
			mixinImport: '@shared/base-classes/with-integrated-b',
			impliedBehaviors: ['external_id_tracking'], // same implied behavior
		});
	});

	test('two patterns implying the same behavior produce no issue', () => {
		const entity = makeEntity({
			name: 'x',
			patterns: ['IntegratedA', 'IntegratedB'],
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: method-name conflict → NOT checked (ADR-031 delegates to TS)
// ============================================================================

describe('validatePatternComposition — OPAQUE method conflicts are NOT checked', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		registerLibraryPattern({
			name: 'MethodA',
			repositoryClass: 'AR',
			repositoryInheritedMethods: ['findThing, countThing'],
		});
		registerLibraryPattern({
			// A capability with a mixin but NO `forwarderMethods`: it contributes
			// methods codegen cannot see, exactly like a base class's.
			name: 'MethodB',
			kind: 'capability',
			mixin: 'WithMethodB',
			mixinImport: '@shared/base-classes/with-method-b',
		});
	});

	test('overlapping method signatures codegen cannot see produce no error', () => {
		const entity = makeEntity({
			name: 'x',
			patterns: ['MethodA', 'MethodB'],
		});
		// `repositoryInheritedMethods` is a doc-comment string and a mixin with no
		// declared vocabulary is opaque, so neither is machine-readable. ADR-031
		// and ADR-041 §4 both leave this remainder to the consumer's compiler;
		// what ADR-041 made checkable is `forwarderMethods`, covered below.
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: config: key for an unused pattern → warning
// ============================================================================

describe('validatePatternComposition — unused config keys', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		registerLibraryPattern({
			name: 'Used',
			repositoryClass: 'UsedRepo',
		});
	});

	test('config block with a key for an undeclared pattern → warning', () => {
		const entity = makeEntity({
			name: 'x',
			pattern: 'Used',
			patternConfig: { Unused: { foo: 'bar' } },
		});
		const issues = validatePatternComposition(entity);
		expect(errors(issues)).toEqual([]);
		const warns = warnings(issues);
		expect(warns.length).toBe(1);
		expect(warns[0]!.type).toBe('pattern_config_unused');
		expect(warns[0]!.message).toMatch(/'Unused'/);
	});

	test('config block keyed correctly for the declared pattern → no issues', () => {
		const entity = makeEntity({
			name: 'x',
			pattern: 'Used',
			patternConfig: { Used: { any: 'value' } },
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: pattern config fails its Zod schema → error
// ============================================================================

describe('validatePatternComposition — configSchema validation', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		registerLibraryPattern({
			name: 'CrmEntity',
			repositoryClass: 'CrmEntityRepository',
			configSchema: z.object({ entityType: z.string() }),
		});
	});

	test('valid config passes the configSchema', () => {
		const entity = makeEntity({
			name: 'opportunity',
			pattern: 'CrmEntity',
			patternConfig: { CrmEntity: { entityType: 'opportunity' } },
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});

	test('missing required config field → error', () => {
		const entity = makeEntity({
			name: 'opportunity',
			pattern: 'CrmEntity',
			patternConfig: { CrmEntity: {} },
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_config_invalid');
		expect(errs[0]!.message).toMatch(/entityType/);
	});

	test('wrong type in config → error', () => {
		const entity = makeEntity({
			name: 'opportunity',
			pattern: 'CrmEntity',
			patternConfig: { CrmEntity: { entityType: 42 as unknown as string } },
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_config_invalid');
		expect(errs[0]!.message).toMatch(/entityType/);
	});

	test('patterns without configSchema accept any (or no) config', () => {
		registerLibraryPattern({
			name: 'NoConfig',
			repositoryClass: 'NCR',
		});
		const entity = makeEntity({
			name: 'x',
			pattern: 'NoConfig',
			patternConfig: { NoConfig: { anything: 'goes' } },
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// ADR-041 §2 — `patterns: [Integrated, Activity]` is a HARD ERROR
//
// These cases previously asserted that the pair validated clean. It did — and
// then emission silently dropped everything `Activity` contributes, including
// the `config:` block these tests supply, because only `patterns[0]` reached
// the template. ADR-041 §2 names this exact pair as the worked example of two
// config-bearing spine bases and rules it an error "until one is authored as a
// capability". The config-validation rows are kept, re-based on a single spine,
// because they cover `configSchema` handling rather than composition.
// ============================================================================

describe('validatePatternComposition — Activity + Integrated composition', () => {
	// Use the real library patterns (barrel pre-registered at top of file). The
	// afterAll() above re-seeds the canonical library set for later files.
	beforeEach(() => {
		_resetRegistryForTests({ includeLibrary: true });
		for (const p of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(p);
	});

	test('patterns: [Integrated, Activity] is rejected — two spine bases', () => {
		const entity = makeEntity({
			name: 'message',
			patterns: ['Integrated', 'Activity'],
			fields: fieldMap(['person_id']),
			patternConfig: { Activity: { subject: 'person' } },
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.map((e) => e.type)).toContain('pattern_multiple_spines');
		expect(errs.find((e) => e.type === 'pattern_multiple_spines')?.message).toContain(
			"kind: 'capability'",
		);
	});

	test('the pair is rejected with no config too — it is about the bases, not the config', () => {
		const entity = makeEntity({
			name: 'message',
			patterns: ['Integrated', 'Activity'],
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.map((e) => e.type)).toContain('pattern_multiple_spines');
	});

	test('invalid Activity config (non-string subject) → pattern_config_invalid', () => {
		const entity = makeEntity({
			name: 'message',
			pattern: 'Activity',
			patternConfig: { Activity: { subject: 42 as unknown as string } },
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_config_invalid');
		expect(errs[0]!.message).toMatch(/Activity/);
	});

	test('unknown Activity config key → pattern_config_invalid (.strict schema)', () => {
		const entity = makeEntity({
			name: 'message',
			pattern: 'Activity',
			patternConfig: { Activity: { subjet: 'person' } },
		});
		const errs = errors(validatePatternComposition(entity));
		expect(errs.length).toBe(1);
		expect(errs[0]!.type).toBe('pattern_config_invalid');
	});
});

// ============================================================================
// ADR-041 composition — spine count + capability vocabulary collisions
// ============================================================================

describe('ADR-041 composition rules', () => {
	beforeEach(() => {
		_resetRegistryForTests({ includeLibrary: true });
		registerLibraryPattern(BasePattern);
		registerLibraryPattern(IntegratedPattern);
		registerLibraryPattern(ActivityPattern);
		registerLibraryPattern(MetadataPattern);
		registerLibraryPattern({
			name: 'VcGroup',
			kind: 'capability',
			mixin: 'WithVcGroup',
			mixinImport: '@shared/base-classes/with-vc-group',
			forwarderMethods: ['members'],
		});
		registerLibraryPattern({
			name: 'VcCrowd',
			kind: 'capability',
			mixin: 'WithVcCrowd',
			mixinImport: '@shared/base-classes/with-vc-crowd',
			// Same vocabulary as VcGroup — the composed class can only declare it once.
			forwarderMethods: ['members'],
		});
		registerLibraryPattern({
			name: 'VcShadow',
			kind: 'capability',
			mixin: 'WithVcShadow',
			mixinImport: '@shared/base-classes/with-vc-shadow',
			// Redeclares a method every spine inherits (#688).
			forwarderMethods: ['findById'],
		});
	});

	test('two config-bearing bases is an error — ADR-041 §2 worked example', () => {
		const entity = makeEntity({
			name: 'message',
			patterns: ['Integrated', 'Activity'],
		});
		const issues = errors(validatePatternComposition(entity));
		const spineIssues = issues.filter((i) => i.type === 'pattern_multiple_spines');
		expect(spineIssues).toHaveLength(1);
		expect(spineIssues[0]?.message).toContain('Integrated, Activity');
	});

	test('two inheritable bases is an error even when neither carries config', () => {
		// The constraint is single inheritance, not config-bearing-ness: dropping
		// `Metadata` silently is the defect ADR-041 opens with.
		const entity = makeEntity({
			name: 'record',
			patterns: ['Integrated', 'Metadata'],
		});
		const issues = errors(validatePatternComposition(entity));
		expect(issues.filter((i) => i.type === 'pattern_multiple_spines')).toHaveLength(1);
	});

	test('one spine plus capabilities validates clean', () => {
		const entity = makeEntity({
			name: 'account',
			patterns: ['VcGroup', 'Integrated'],
		});
		expect(errors(validatePatternComposition(entity))).toEqual([]);
	});

	test('two capabilities contributing the same method is an error', () => {
		const entity = makeEntity({
			name: 'crowd',
			patterns: ['VcGroup', 'VcCrowd'],
		});
		const issues = errors(validatePatternComposition(entity));
		const collisions = issues.filter((i) => i.type === 'pattern_method_collision');
		expect(collisions).toHaveLength(1);
		expect(collisions[0]?.message).toContain("'members'");
	});

	test('a capability method shadowing a spine-inherited method is an error (#688)', () => {
		const entity = makeEntity({ name: 'account', patterns: ['VcShadow', 'Integrated'] });
		const collisions = errors(validatePatternComposition(entity)).filter(
			(i) => i.type === 'pattern_method_collision',
		);
		expect(collisions).toHaveLength(1);
		expect(collisions[0]?.message).toContain("the spine 'Integrated'");
	});

	test('a capability is never reported as an unknown pattern', () => {
		const entity = makeEntity({ name: 'account', patterns: ['VcGroup'] });
		const issues = errors(validatePatternComposition(entity));
		expect(issues.filter((i) => i.type === 'pattern_unknown')).toEqual([]);
	});
});

// ============================================================================
// ADR-041.1 — the library Actor capability's config
// ============================================================================

describe('validatePatternComposition — Actor config (CAP-3)', () => {
	beforeEach(() => {
		_resetRegistryForTests({ includeLibrary: true });
		for (const p of LIBRARY_PATTERN_DEFINITIONS) registerLibraryPattern(p);
	});

	const actor = (config: unknown, relationships: ParsedEntity['relationships'] = new Map()) => ({
		...makeEntity({
			name: 'account',
			patterns: ['Actor'],
			patternConfig: config === undefined ? undefined : { Actor: config },
		}),
		relationships,
	});

	test('config is required — an Actor must say individual or group', () => {
		expect(errors(validatePatternComposition(actor(undefined))).map((i) => i.type)).toEqual([
			'pattern_config_invalid',
		]);
	});

	test('a group whose members: names a has_many is clean', () => {
		const rels: ParsedEntity['relationships'] = new Map([
			['contacts', { name: 'contacts', type: 'has_many', target: 'contact', foreignKey: 'account_id', resolved: true }],
		]);
		expect(errors(validatePatternComposition(actor({ kind: 'group', members: 'contacts' }, rels)))).toEqual([]);
	});

	test('a group whose members: is missing or not a has_many is an error', () => {
		const rels: ParsedEntity['relationships'] = new Map([
			['owner', { name: 'owner', type: 'belongs_to', target: 'contact', foreignKey: 'owner_id', resolved: true }],
		]);
		const missing = errors(validatePatternComposition(actor({ kind: 'group', members: 'contacts' })));
		expect(missing.map((i) => i.type)).toEqual(['actor_members_not_has_many']);
		const wrong = errors(validatePatternComposition(actor({ kind: 'group', members: 'owner' }, rels)));
		expect(wrong.map((i) => i.message)).toEqual([
			"Actor members: 'owner' must name one of the entity's has_many relationships ('owner' is a belongs_to).",
		]);
	});
});
