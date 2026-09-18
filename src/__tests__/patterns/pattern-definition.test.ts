/**
 * Unit tests for `definePattern` identity + `isPatternDefinition` shape guard.
 */

import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
	defineCapabilityPattern,
	isCapabilityPattern,
	isDomainPattern,
	definePattern,
	isPatternDefinition,
	type PatternDefinition,
} from '../../patterns/pattern-definition.ts';

describe('definePattern', () => {
	test('returns its argument unchanged (identity)', () => {
		const input: PatternDefinition = {
			name: 'Test',
			repositoryClass: 'TestRepository',
		};
		const output = definePattern(input);
		expect(output).toBe(input);
	});

	test('preserves generic config-schema inference', () => {
		const schema = z.object({ entityType: z.string() });
		const pattern = definePattern({
			name: 'Custom',
			repositoryClass: 'CustomRepository',
			configSchema: schema,
		});
		expect(pattern.configSchema).toBe(schema);
	});
});

describe('isPatternDefinition', () => {
	test('accepts a value with a string `name`', () => {
		expect(isPatternDefinition({ name: 'Ok' })).toBe(true);
	});

	test('accepts a full PatternDefinition', () => {
		expect(
			isPatternDefinition({
				name: 'Full',
				repositoryClass: 'R',
				serviceClass: 'S',
				columns: [{ name: 'x', type: 'text' }],
			}),
		).toBe(true);
	});

	test('rejects null, undefined, and non-objects', () => {
		expect(isPatternDefinition(null)).toBe(false);
		expect(isPatternDefinition(undefined)).toBe(false);
		expect(isPatternDefinition('name')).toBe(false);
		expect(isPatternDefinition(42)).toBe(false);
	});

	test('rejects objects missing `name`', () => {
		expect(isPatternDefinition({})).toBe(false);
		expect(isPatternDefinition({ repositoryClass: 'X' })).toBe(false);
	});

	test('rejects objects where `name` is not a string', () => {
		expect(isPatternDefinition({ name: 42 })).toBe(false);
		expect(isPatternDefinition({ name: null })).toBe(false);
	});
});

// ============================================================================
// Capability kind (ADR-041)
// ============================================================================

describe('defineCapabilityPattern + kind guards', () => {
	const ActorPattern = defineCapabilityPattern({
		name: 'Actor',
		kind: 'capability',
		mixin: 'WithActor',
		mixinImport: '@shared/base-classes/with-actor',
		forwarderMethods: ['findByRole'],
		configSchema: z.object({ kind: z.enum(['individual', 'group']) }).strict(),
	});

	test('returns its argument unchanged', () => {
		expect(ActorPattern.name).toBe('Actor');
		expect(ActorPattern.mixin).toBe('WithActor');
		expect(ActorPattern.forwarderMethods).toEqual(['findByRole']);
	});

	test('isCapabilityPattern narrows on kind', () => {
		expect(isCapabilityPattern(ActorPattern)).toBe(true);
		expect(isCapabilityPattern({ name: 'Base' })).toBe(false);
		expect(isCapabilityPattern({ name: 'Orch', kind: 'orchestration' } as never)).toBe(
			false,
		);
	});

	test('a capability is NOT a domain pattern — the guard checks kind, not "not orchestration"', () => {
		expect(isDomainPattern(ActorPattern)).toBe(false);
		expect(isDomainPattern({ name: 'Base' })).toBe(true);
		expect(isDomainPattern({ name: 'Base', kind: 'domain' })).toBe(true);
	});

	test('a capability passes the kind-agnostic shape check', () => {
		expect(isPatternDefinition(ActorPattern)).toBe(true);
	});
});
