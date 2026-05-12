/**
 * JunctionPattern registry-surface tests.
 *
 * Confirms the pattern is reachable through the library barrel, the
 * column contribution is intact, and the BaseJunctionFields shape is
 * stable.
 */

import { describe, test, expect } from 'bun:test';

// Importing the barrel pre-registers the 6 library patterns as a side effect
// (Base / Synced / Activity / Knowledge / Metadata / Junction).
import '../../patterns/index.ts';

import {
	getPattern,
	getLibraryPatternNames,
} from '../../patterns/registry.ts';
import {
	JunctionPattern,
	BaseJunctionFields,
	BASE_JUNCTION_FIELD_NAMES,
} from '../../patterns/library/index.ts';

describe('JunctionPattern', () => {
	test('is registered under the name "Junction"', () => {
		const def = getPattern('Junction');
		expect(def).toBeDefined();
		expect(def?.name).toBe('Junction');
	});

	test('appears in getLibraryPatternNames()', () => {
		expect(getLibraryPatternNames()).toContain('Junction');
	});

	test('declares no base class (junction emits its own repo/service)', () => {
		expect(JunctionPattern.repositoryClass).toBeUndefined();
		expect(JunctionPattern.serviceClass).toBeUndefined();
	});

	test('contributes BaseJunctionFields as columns', () => {
		expect(JunctionPattern.columns).toBeDefined();
		const got = (JunctionPattern.columns ?? []).map((c) => c.name);
		expect(got).toEqual([
			'is_primary',
			'started_at',
			'ended_at',
			'sourced_from',
			'confidence',
			'matched_at',
		]);
	});

	test('exposes a configSchema (thin in v1; reserved for downstream leaves)', () => {
		expect(JunctionPattern.configSchema).toBeDefined();
	});
});

describe('BaseJunctionFields', () => {
	test('exports the six expected columns in documented order', () => {
		expect(BaseJunctionFields.map((c) => c.name)).toEqual([
			'is_primary',
			'started_at',
			'ended_at',
			'sourced_from',
			'confidence',
			'matched_at',
		]);
	});

	test('column types match the spec', () => {
		const byName = new Map(BaseJunctionFields.map((c) => [c.name, c.type]));
		expect(byName.get('is_primary')).toBe('boolean');
		expect(byName.get('started_at')).toBe('timestamp');
		expect(byName.get('ended_at')).toBe('timestamp');
		expect(byName.get('sourced_from')).toBe('text');
		expect(byName.get('confidence')).toBe('numeric(5,4)');
		expect(byName.get('matched_at')).toBe('timestamp');
	});

	test('BASE_JUNCTION_FIELD_NAMES is the matching set', () => {
		expect(BASE_JUNCTION_FIELD_NAMES.size).toBe(BaseJunctionFields.length);
		for (const col of BaseJunctionFields) {
			expect(BASE_JUNCTION_FIELD_NAMES.has(col.name)).toBe(true);
		}
	});
});
