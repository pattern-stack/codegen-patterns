/**
 * Orchestration emission — byte-identical golden test (ADR-032 Phase 3-2/3).
 *
 * Loads the `valid-crm-ports.pattern.ts` fixture, runs the pure content-builders,
 * and diffs each emitted file against the hand-written baseline under
 * `baseline/crm-ports/`. Any byte drift fails the test.
 *
 * Tests also cover the emission-time guards:
 *   - `pattern_missing_import_path`  — keyTypeImport / valueTypeImport / providerImport.
 *   - `pattern_keytype_unresolved`   — primitive keyTypes (string|number|symbol|any|unknown).
 *   - `pattern_cokeyed_missing_name` — co-keyed siblings without an explicit `name`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineOrchestrationPattern } from '../../patterns/pattern-definition.ts';
import { CrmPortsPattern } from './fixtures/orchestration/valid-crm-ports.pattern.ts';
import {
	OrchestrationEmissionError,
	buildDispatcherTs,
	buildIndexTs,
	buildModuleTs,
	buildPatternFiles,
	buildProvidersTs,
	buildRootBarrelTs,
	buildTokensTs,
	generateOrchestrationModules,
	toKebabCase,
	toPascalCase,
	toScreamingSnake,
} from '../../cli/shared/orchestration-generator.ts';

const BASELINE_DIR = path.join(
	import.meta.dir,
	'fixtures/orchestration/baseline/crm-ports',
);

// ---------------------------------------------------------------------------
// Case helpers (sanity)
// ---------------------------------------------------------------------------

describe('orchestration-generator case helpers', () => {
	test('toKebabCase / toPascalCase / toScreamingSnake', () => {
		expect(toKebabCase('CrmPorts')).toBe('crm-ports');
		expect(toPascalCase('crm-ports')).toBe('CrmPorts');
		expect(toScreamingSnake('CrmPorts')).toBe('CRM_PORTS');
		expect(toScreamingSnake('iam-policies')).toBe('IAM_POLICIES');
	});
});

// ---------------------------------------------------------------------------
// Byte-identical golden test
// ---------------------------------------------------------------------------

describe('orchestration emission — golden output (CrmPorts)', () => {
	const result = buildPatternFiles(CrmPortsPattern, path.dirname(BASELINE_DIR));

	test('emits exactly five files in the expected order', () => {
		expect(result.files.map((f) => f.name)).toEqual([
			'tokens.ts',
			'registry.providers.ts',
			'dispatcher.ts',
			'module.ts',
			'index.ts',
		]);
		expect(result.slug).toBe('crm-ports');
	});

	for (const filename of [
		'tokens.ts',
		'registry.providers.ts',
		'dispatcher.ts',
		'module.ts',
		'index.ts',
	]) {
		test(`${filename} matches baseline byte-for-byte`, () => {
			const f = result.files.find((x) => x.name === filename)!;
			const baseline = readFileSync(path.join(BASELINE_DIR, filename), 'utf-8');
			expect(f.content).toBe(baseline);
		});
	}
});

// ---------------------------------------------------------------------------
// Top-level barrel (O-7)
// ---------------------------------------------------------------------------

describe('top-level barrel (O-7)', () => {
	test('zero patterns emits an empty barrel', () => {
		const out = buildRootBarrelTs([]);
		expect(out).toContain('No orchestration patterns');
		expect(out).toContain('export {};');
	});

	test('multiple patterns re-export each per-pattern barrel sorted by slug', () => {
		const A = defineOrchestrationPattern({
			name: 'BravoPorts',
			kind: 'orchestration',
			registry: {
				keyType: 'BravoDomain',
				keyTypeImport: '@/x',
				valueType: 'IBravo',
				valueTypeImport: '@/y',
				entries: [{ key: 'a', provider: 'Foo', providerImport: '@/foo' }],
			},
		});
		const B = defineOrchestrationPattern({
			name: 'AlphaPorts',
			kind: 'orchestration',
			registry: {
				keyType: 'AlphaDomain',
				keyTypeImport: '@/x',
				valueType: 'IAlpha',
				valueTypeImport: '@/y',
				entries: [{ key: 'a', provider: 'Bar', providerImport: '@/bar' }],
			},
		});
		const out = buildRootBarrelTs([A, B]);
		const idxAlpha = out.indexOf("'./alpha-ports/index.js'");
		const idxBravo = out.indexOf("'./bravo-ports/index.js'");
		expect(idxAlpha).toBeGreaterThan(-1);
		expect(idxBravo).toBeGreaterThan(idxAlpha);
	});
});

// ---------------------------------------------------------------------------
// Emission-time guards
// ---------------------------------------------------------------------------

describe('emission-time guards', () => {
	test('rejects co-keyed sibling missing `name`', () => {
		const bad = defineOrchestrationPattern({
			name: 'Bad',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				keyTypeImport: '@/k',
				valueType: 'V',
				valueTypeImport: '@/v',
				entries: [{ key: 'x', provider: 'P', providerImport: '@/p' }],
			},
			coKeyedRegistries: [
				{
					// name intentionally omitted
					keyType: 'K',
					keyTypeImport: '@/k',
					valueType: 'V2',
					valueTypeImport: '@/v2',
					entries: [{ key: 'x', provider: 'P2', providerImport: '@/p2' }],
				},
			],
		});
		expect(() => buildPatternFiles(bad, '/tmp')).toThrow(
			OrchestrationEmissionError,
		);
	});

	test('rejects missing keyTypeImport / valueTypeImport / providerImport', () => {
		const bad = defineOrchestrationPattern({
			name: 'Bad',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				// keyTypeImport omitted
				valueType: 'V',
				valueTypeImport: '@/v',
				entries: [{ key: 'x', provider: 'P', providerImport: '@/p' }],
			},
		});
		expect(() => buildPatternFiles(bad, '/tmp')).toThrow(
			/pattern_missing_import_path/,
		);
	});

	test('rejects primitive keyTypes (R-3)', () => {
		for (const bad of ['string', 'number', 'symbol', 'any', 'unknown']) {
			const pattern = defineOrchestrationPattern({
				name: 'Bad',
				kind: 'orchestration',
				registry: {
					keyType: bad,
					keyTypeImport: '@/k',
					valueType: 'V',
					valueTypeImport: '@/v',
					entries: [{ key: 'x', provider: 'P', providerImport: '@/p' }],
				},
			});
			expect(() => buildPatternFiles(pattern, '/tmp')).toThrow(
				/pattern_keytype_unresolved/,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Risk-flag micro-tests
// ---------------------------------------------------------------------------

describe('risk-flag coverage', () => {
	test('R-1: overload signatures appear in specific → general → impl order', () => {
		const out = buildDispatcherTs(CrmPortsPattern);
		const lines = out.split('\n');
		// Find both `select(` lines for the primary registry. The first three
		// are overloads (specific × 2, widening), the fourth is the impl.
		const selectLines = lines
			.map((l, i) => ({ l: l.trim(), i }))
			.filter((x) => x.l.startsWith('select(key:'));
		// There are 4 primary `select(` plus 4 secondary `selectAuth(` = 8 total.
		const primary = selectLines.filter((x) => x.l.startsWith('select(key:'));
		// Pick first 4 (primary). Specific overloads carry quoted literal keys.
		const specific1 = primary[0]!.l.includes("'salesforce-crm'");
		const specific2 = primary[1]!.l.includes("'hubspot-crm'");
		const widening = primary[2]!.l.includes('CrmAdapterDomain');
		const impl = primary[3]!.l.includes('{');
		expect(specific1 && specific2 && widening && impl).toBe(true);
	});

	test('R-4: registry fields are protected readonly (not private)', () => {
		const out = buildDispatcherTs(CrmPortsPattern);
		expect(out).toContain('protected readonly registry');
		expect(out).toContain('protected readonly authRegistry');
		expect(out).not.toContain('private readonly registry');
	});
});

// ---------------------------------------------------------------------------
// generateOrchestrationModules dryRun smoke
// ---------------------------------------------------------------------------

describe('generateOrchestrationModules dryRun', () => {
	test('returns per-pattern files + a top-level barrel without writing to disk', () => {
		const result = generateOrchestrationModules({
			patterns: [CrmPortsPattern],
			outputRoot: '/tmp/orch-output',
			dryRun: true,
		});
		expect(result.written).toBe(false);
		expect(result.patterns).toHaveLength(1);
		expect(result.patterns[0]!.files).toHaveLength(5);
		// 5 per-pattern files + 1 root barrel.
		expect(result.files).toHaveLength(6);
		const rootBarrel = result.files.find(
			(f) => f.relativePath === 'index.ts',
		);
		expect(rootBarrel).toBeDefined();
	});
});
