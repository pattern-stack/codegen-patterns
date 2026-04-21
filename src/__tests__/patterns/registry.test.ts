/**
 * Unit tests for the pattern registry — library/app storage, lookup,
 * `loadAppPatterns()` glob discovery, and two-process determinism.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { definePattern } from '../../patterns/pattern-definition.ts';
import {
	_resetRegistryForTests,
	getAllPatternNames,
	getAppPatternNames,
	getLibraryPatternNames,
	getPattern,
	loadAppPatterns,
	registerLibraryPattern,
} from '../../patterns/registry.ts';

// Importing the barrel pre-registers the 5 library patterns as a side effect.
// Tests that need library patterns present should `import '.../patterns/index.ts'`
// at the top of their describe block.
import '../../patterns/index.ts';

// ============================================================================
// Library pre-registration
// ============================================================================

describe('library pattern pre-registration', () => {
	test('the 5 library patterns are present after importing the barrel', () => {
		const libNames = getLibraryPatternNames();
		expect(libNames).toContain('Base');
		expect(libNames).toContain('Synced');
		expect(libNames).toContain('Activity');
		expect(libNames).toContain('Knowledge');
		expect(libNames).toContain('Metadata');
	});

	test('library lookup returns the expected class/import metadata', () => {
		const synced = getPattern('Synced');
		expect(synced).toBeDefined();
		expect(synced?.repositoryClass).toBe('SyncedEntityRepository');
		expect(synced?.repositoryImport).toBe(
			'@shared/base-classes/synced-entity-repository',
		);
		expect(synced?.impliedBehaviors).toEqual(['external_id_tracking']);
	});

	test('consumers do not need to list library patterns in a manifest', async () => {
		// loadAppPatterns with an empty manifest must still leave library
		// patterns resolvable — they live in a separate store.
		_resetRegistryForTests(); // clears APP_PATTERNS, leaves LIBRARY_PATTERNS
		const result = await loadAppPatterns([], process.cwd());
		expect(result.loaded).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(getPattern('Synced')).toBeDefined();
	});
});

// ============================================================================
// Registry insert/lookup semantics
// ============================================================================

describe('registry insert/lookup', () => {
	beforeEach(() => {
		_resetRegistryForTests(); // clear APP_PATTERNS only
	});

	test('registerLibraryPattern rejects a pattern with no contributions', () => {
		expect(() =>
			registerLibraryPattern(
				definePattern({ name: 'Empty' }) as unknown as Parameters<
					typeof registerLibraryPattern
				>[0],
			),
		).toThrow(/contributes nothing/);
	});

	test('registerLibraryPattern accepts a columns-only pattern', () => {
		registerLibraryPattern({
			name: 'ColumnsOnly',
			columns: [{ name: 'external_id', type: 'varchar(255)' }],
		});
		expect(getPattern('ColumnsOnly')?.name).toBe('ColumnsOnly');
	});

	test('getPattern returns undefined for unknown names', () => {
		expect(getPattern('DefinitelyNotARealPatternName')).toBeUndefined();
	});

	test('getAllPatternNames dedupes + sorts library and app names', () => {
		// library has Base/Synced/Activity/Knowledge/Metadata already;
		// inject an app pattern and verify sort order.
		_resetRegistryForTests();
		const names = getAllPatternNames();
		for (let i = 1; i < names.length; i++) {
			expect(names[i - 1]!.localeCompare(names[i]!)).toBeLessThanOrEqual(0);
		}
	});
});

// ============================================================================
// loadAppPatterns — glob + dynamic import
// ============================================================================

describe('loadAppPatterns', () => {
	// Each test gets its own tmpdir so concurrent runs don't collide.
	let tmpdir: string;

	beforeEach(() => {
		tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-registry-'));
		fs.mkdirSync(path.join(tmpdir, 'src', 'patterns'), { recursive: true });
		_resetRegistryForTests();
	});

	afterAll(() => {
		// tmpdirs are small; leave the OS to clean them up if a test bailed
		// out mid-way. Best-effort cleanup of anything we can see:
		try {
			for (const leftover of fs.readdirSync(os.tmpdir())) {
				if (leftover.startsWith('pattern-registry-')) {
					fs.rmSync(path.join(os.tmpdir(), leftover), {
						recursive: true,
						force: true,
					});
				}
			}
		} catch {
			// ignore
		}
	});

	function writePatternFile(relPath: string, source: string): string {
		const abs = path.join(tmpdir, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, source, 'utf8');
		return abs;
	}

	test('discovers + registers a valid pattern via default glob shape', async () => {
		// `definePattern` is re-exported from the barrel; app files import
		// from the built package in real use, but for tests we point at the
		// in-repo source via an absolute path so Bun resolves it.
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/custom.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const CustomPattern = definePattern({
	name: 'Custom',
	repositoryClass: 'CustomRepository',
	repositoryImport: '@/patterns/custom',
});
`,
		);

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		expect(result.errors).toEqual([]);
		expect(result.loaded).toEqual(['Custom']);
		expect(getPattern('Custom')?.repositoryClass).toBe('CustomRepository');
		expect(getAppPatternNames()).toEqual(['Custom']);
	});

	test('ignores exports that are not pattern definitions', async () => {
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/mixed.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const helper = () => 42;
export const MY_CONST = 'not a pattern';
export const danglingConst = { name: "Dangling" }; // export key does not end in "Pattern" — ignored
export const RealPattern = definePattern({
	name: 'Real',
	serviceClass: 'RealService',
});
`,
		);

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		expect(result.errors).toEqual([]);
		// Only the `RealPattern` export is registered: helper + MY_CONST
		// fail `isPatternDefinition` (no string `name`), and
		// `danglingConst` is skipped because its export key does
		// not end in 'Pattern'.
		expect(result.loaded).toEqual(['Real']);
	});

	test('reports pattern files that fail to import as errors, does not throw', async () => {
		writePatternFile(
			'src/patterns/broken.pattern.ts',
			"this is not valid TypeScript ;; syntax error",
		);
		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);
		expect(result.loaded).toEqual([]);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toMatch(/Failed to load pattern file/);
	});

	test('reports an invalid pattern (no contributions) as an error', async () => {
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/empty.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const EmptyPattern = definePattern({ name: 'Empty' });
`,
		);

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		expect(result.loaded).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toMatch(/contributes nothing/);
	});

	test('dedupes a file matched by two overlapping globs', async () => {
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/double.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const DoublePattern = definePattern({
	name: 'Double',
	repositoryClass: 'DoubleRepository',
});
`,
		);

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts', 'src/**/*.pattern.ts'],
			tmpdir,
		);

		expect(result.errors).toEqual([]);
		expect(result.loaded).toEqual(['Double']);
	});

	test('loaded list is sorted — determinism basis', async () => {
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/z.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const ZetaPattern = definePattern({
	name: 'Zeta',
	repositoryClass: 'ZR',
});
`,
		);
		writePatternFile(
			'src/patterns/a.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const AlphaPattern = definePattern({
	name: 'Alpha',
	repositoryClass: 'AR',
});
`,
		);

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		expect(result.errors).toEqual([]);
		expect(result.loaded).toEqual(['Alpha', 'Zeta']);
	});

	test('idempotent: loading twice leaves the same state', async () => {
		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		writePatternFile(
			'src/patterns/same.pattern.ts',
			`
import { definePattern } from '${barrel}';
export const SamePattern = definePattern({
	name: 'Same',
	repositoryClass: 'SameRepository',
});
`,
		);

		const first = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);
		const second = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);
		expect(second.loaded).toEqual(first.loaded);
		expect(getAppPatternNames()).toEqual(['Same']);
	});
});

// ============================================================================
// Two-process determinism — ADR risk #1
// ============================================================================

describe('two-process determinism', () => {
	// The Hygen subprocess builds a fresh registry per `entity new` run
	// independently of the CLI. Both must resolve identically. Here we
	// simulate the subprocess via a second bun invocation and compare
	// its registry snapshot to ours.

	test('same files produce the same sorted registry in a fresh process', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-deterministic-'));
		fs.mkdirSync(path.join(tmp, 'src', 'patterns'), { recursive: true });

		const barrel = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);

		fs.writeFileSync(
			path.join(tmp, 'src', 'patterns', 'one.pattern.ts'),
			`
import { definePattern } from '${barrel}';
export const OnePattern = definePattern({
	name: 'One',
	repositoryClass: 'OneR',
});
`,
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'patterns', 'two.pattern.ts'),
			`
import { definePattern } from '${barrel}';
export const TwoPattern = definePattern({
	name: 'Two',
	repositoryClass: 'TwoR',
});
`,
		);

		// Process A — in-test
		_resetRegistryForTests();
		const a = await loadAppPatterns(['src/patterns/*.pattern.ts'], tmp);

		// Process B — spawn bun with a one-liner that loads the registry and
		// emits its own sorted view.
		const registryPath = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/registry.ts',
		);
		const barrelPath = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/index.ts',
		);
		const child = spawnSync(
			'bun',
			[
				'-e',
				`
await import('${barrelPath}');
const { loadAppPatterns, getAppPatternNames } = await import('${registryPath}');
const res = await loadAppPatterns(['src/patterns/*.pattern.ts'], '${tmp}');
process.stdout.write(JSON.stringify({
	loaded: res.loaded,
	errors: res.errors,
	appNames: getAppPatternNames(),
}));
`,
			],
			{ encoding: 'utf8' },
		);

		expect(child.status).toBe(0);
		const b = JSON.parse(child.stdout) as {
			loaded: string[];
			errors: string[];
			appNames: string[];
		};

		expect(b.errors).toEqual([]);
		expect(a.errors).toEqual([]);
		expect(a.loaded).toEqual(b.loaded);
		expect(a.loaded).toEqual(['One', 'Two']); // alphabetical
		expect(b.appNames).toEqual(['One', 'Two']);

		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
