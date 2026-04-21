/**
 * Unit tests for `definePattern` identity + `isPatternDefinition` shape guard.
 */

import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
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
