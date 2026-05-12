/**
 * Unit tests for `validatePatternComposition` + `validatePatternProject`.
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
	validatePatternProject,
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
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
	SyncedPattern,
} from '../../patterns/library/index.ts';

afterAll(() => {
	_resetRegistryForTests({ includeLibrary: true });
	registerLibraryPattern(BasePattern);
	registerLibraryPattern(SyncedPattern);
	registerLibraryPattern(ActivityPattern);
	registerLibraryPattern(KnowledgePattern);
	registerLibraryPattern(MetadataPattern);
	registerLibraryPattern(JunctionPattern);
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

	test('library pattern Synced with no config is valid', () => {
		const entity = makeEntity({ name: 'contact', pattern: 'Synced' });
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
			patterns: ['Synced', 'DoesNotExist', 'AlsoMissing'],
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
		// behavior's `external_id` field (which SyncedPattern implies).
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
			name: 'SyncedA',
			repositoryClass: 'SyncedARepo',
			impliedBehaviors: ['external_id_tracking'],
		});
		registerLibraryPattern({
			name: 'SyncedB',
			repositoryClass: 'SyncedBRepo',
			impliedBehaviors: ['external_id_tracking'], // same implied behavior
		});
	});

	test('two patterns implying the same behavior produce no issue', () => {
		const entity = makeEntity({
			name: 'x',
			patterns: ['SyncedA', 'SyncedB'],
		});
		expect(validatePatternComposition(entity)).toEqual([]);
	});
});

// ============================================================================
// Row: method-name conflict → NOT checked (ADR-031 delegates to TS)
// ============================================================================

describe('validatePatternComposition — method-name conflicts are NOT checked', () => {
	beforeEach(() => {
		_resetRegistryForTests();
		registerLibraryPattern({
			name: 'MethodA',
			repositoryClass: 'AR',
			repositoryInheritedMethods: ['findThing, countThing'],
		});
		registerLibraryPattern({
			name: 'MethodB',
			repositoryClass: 'BR',
			repositoryInheritedMethods: ['findThing, save'], // overlapping method
		});
	});

	test('overlapping method signatures produce no codegen error', () => {
		const entity = makeEntity({
			name: 'x',
			patterns: ['MethodA', 'MethodB'],
		});
		// Per ADR-031 the TypeScript compiler catches this at the
		// consumer. Codegen does not duplicate the check.
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
// Project-level — plan Risk 4
// ============================================================================

describe('validatePatternProject — clean-pipeline no-op warning', () => {
	test('architecture: clean + entities with patterns → warning per entity', () => {
		const entities = [
			makeEntity({ name: 'a', pattern: 'Synced' }),
			makeEntity({ name: 'b', patterns: ['Activity'] }),
			makeEntity({ name: 'c' }), // no pattern — skipped
		];
		const issues = validatePatternProject({ entities, architecture: 'clean' });
		expect(issues.length).toBe(2);
		expect(issues.every((i) => i.severity === 'warning')).toBe(true);
		expect(issues.every((i) => i.type === 'pattern_clean_pipeline_noop')).toBe(true);
		expect(issues.map((i) => i.entity)).toEqual(['a', 'b']);
	});

	test('architecture: clean-lite-ps + entities with patterns → no warning', () => {
		const entities = [makeEntity({ name: 'a', pattern: 'Synced' })];
		const issues = validatePatternProject({
			entities,
			architecture: 'clean-lite-ps',
		});
		expect(issues).toEqual([]);
	});

	test('architecture omitted → no warning (analyzer-only mode)', () => {
		const entities = [makeEntity({ name: 'a', pattern: 'Synced' })];
		const issues = validatePatternProject({ entities });
		expect(issues).toEqual([]);
	});
});
