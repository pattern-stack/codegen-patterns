/**
 * Unit tests for the #121 (F13) pure config-block detector.
 *
 * Purity guarantee: no filesystem access anywhere in `detectConfigBlock`, so
 * these tests are pure string-in / enum-out.
 */
import { describe, expect, test } from 'bun:test';

import {
	detectConfigBlock,
	type SubsystemName,
} from '../../cli/shared/config-block-detect.js';

describe('detectConfigBlock — missing', () => {
	test('empty string', () => {
		expect(detectConfigBlock('', 'jobs')).toBe('missing');
	});

	test('whitespace-only', () => {
		expect(detectConfigBlock('   \n\n\t\n', 'jobs')).toBe('missing');
	});

	test('comments-only YAML', () => {
		expect(detectConfigBlock('# a YAML file\n# with only comments\n', 'jobs')).toBe(
			'missing',
		);
	});

	test('YAML without the subsystem key', () => {
		const src = 'paths:\n  subsystems: src/shared/subsystems\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('missing');
		expect(detectConfigBlock(src, 'events')).toBe('missing');
	});

	test('YAML with a different subsystem key', () => {
		const src = 'events:\n  backend: drizzle\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('missing');
	});

	test('commented-out block (# jobs:)', () => {
		const src = '# jobs:\n#   backend: drizzle\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('missing');
	});

	test('subsystem name appearing inside a string value of another key', () => {
		const src = 'description: "The jobs: block is optional."\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('missing');
	});

	test('top-level array is missing any block', () => {
		expect(detectConfigBlock('- item-a\n- item-b\n', 'jobs')).toBe('missing');
	});

	test('top-level scalar is missing any block', () => {
		expect(detectConfigBlock('hello\n', 'jobs')).toBe('missing');
	});
});

describe('detectConfigBlock — present (various shapes)', () => {
	test('full map value', () => {
		const src = 'jobs:\n  backend: drizzle\n  multi_tenant: false\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('present');
	});

	test('explicit null value', () => {
		expect(detectConfigBlock('jobs: null\n', 'jobs')).toBe('present');
	});

	test('bare key (implicit null)', () => {
		expect(detectConfigBlock('jobs:\n', 'jobs')).toBe('present');
	});

	test('flow-style empty map', () => {
		expect(detectConfigBlock('jobs: {}\n', 'jobs')).toBe('present');
	});

	test('events alongside other top-level keys', () => {
		const src = [
			'paths:',
			'  subsystems: src/shared/subsystems',
			'events:',
			'  backend: drizzle',
			'  multi_tenant: true',
			'',
		].join('\n');
		expect(detectConfigBlock(src, 'events')).toBe('present');
		// jobs still missing in the same source
		expect(detectConfigBlock(src, 'jobs')).toBe('missing');
	});

	test('cache / storage (forward-compat subsystem names)', () => {
		const src = 'cache:\n  backend: memory\nstorage:\n  backend: local\n';
		expect(detectConfigBlock(src, 'cache')).toBe('present');
		expect(detectConfigBlock(src, 'storage')).toBe('present');
	});
});

describe('detectConfigBlock — parse errors', () => {
	test('unbalanced quote', () => {
		const src = 'jobs:\n  backend: "unterminated\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('parse-error');
	});

	test('tab-indented mapping (invalid YAML)', () => {
		// YAML 1.2 forbids tab-indented block scalars; eemeli/yaml rejects.
		const src = 'jobs:\n\tbackend: drizzle\n';
		const state = detectConfigBlock(src, 'jobs');
		// Accept either 'parse-error' (strict mode) or 'present' (lenient parse).
		// We only assert that it does NOT silently come back 'missing' for a
		// clearly-intended block — that would be the dangerous false negative.
		expect(state === 'parse-error' || state === 'present').toBe(true);
	});

	test('duplicate top-level keys', () => {
		// eemeli/yaml v2 rejects duplicate keys by default.
		const src = 'jobs:\n  backend: drizzle\njobs:\n  backend: memory\n';
		expect(detectConfigBlock(src, 'jobs')).toBe('parse-error');
	});
});

describe('detectConfigBlock — SubsystemName type exhaustiveness', () => {
	test('all four names are accepted at the type level', () => {
		// Purely a compile-time check — runtime just confirms it returns one of
		// the three enum values for each.
		const names: SubsystemName[] = ['jobs', 'events', 'cache', 'storage'];
		for (const n of names) {
			const state = detectConfigBlock('', n);
			expect(['missing', 'present', 'parse-error']).toContain(state);
		}
	});
});
