/**
 * Unit tests for `validateOrchestrationProject` and the loader-side
 * orchestration routing introduced in ADR-032 Phase 3-1.
 *
 * The validator takes context literals (orchestrationPatterns +
 * domainPatternNames) directly — no test-only registration helper. Loader
 * tests use real fixture files via `loadAppPatterns()` to exercise the
 * import + routing path end-to-end.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	defineOrchestrationPattern,
	type OrchestrationPatternDefinition,
} from '../../patterns/pattern-definition.ts';
import {
	_resetRegistryForTests,
	getAllOrchestrationPatterns,
	getOrchestrationPattern,
	getOrchestrationPatternNames,
	loadAppPatterns,
	registerLibraryPattern,
} from '../../patterns/registry.ts';
import { validateOrchestrationProject } from '../../patterns/validate-orchestration.ts';

// Side-effect: pre-register library domain patterns.
import '../../patterns/index.ts';
import {
	ActivityPattern,
	BasePattern,
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
	IntegratedPattern,
} from '../../patterns/library/index.ts';

// Re-seed library patterns once this file finishes so subsequent test
// files in the same Bun process see the canonical registry.
afterAll(() => {
	_resetRegistryForTests({ includeLibrary: true });
	registerLibraryPattern(BasePattern);
	registerLibraryPattern(IntegratedPattern);
	registerLibraryPattern(ActivityPattern);
	registerLibraryPattern(KnowledgePattern);
	registerLibraryPattern(MetadataPattern);
	registerLibraryPattern(JunctionPattern);
});

// ============================================================================
// Direct validator tests (literals)
// ============================================================================

describe('validateOrchestrationProject — happy paths', () => {
	test('no orchestration patterns → no issues', () => {
		expect(
			validateOrchestrationProject({
				orchestrationPatterns: [],
				domainPatternNames: ['Integrated', 'Activity'],
			}),
		).toEqual([]);
	});

	test('single well-formed registry, two entries → no issues', () => {
		const orch = defineOrchestrationPattern({
			name: 'CrmPorts',
			kind: 'orchestration',
			registry: {
				keyType: 'CrmAdapterDomain',
				valueType: 'ICrmPort',
				entries: [
					{ key: 'salesforce-crm', provider: 'SalesforceCrmAdapter' },
					{ key: 'hubspot-crm', provider: 'HubSpotCrmAdapter' },
				],
			},
		});
		expect(
			validateOrchestrationProject({
				orchestrationPatterns: [orch],
				domainPatternNames: ['Integrated'],
			}),
		).toEqual([]);
	});

	test('co-keyed registries with matching keyType → no issues', () => {
		const orch = defineOrchestrationPattern({
			name: 'CrmPortsCoKeyed',
			kind: 'orchestration',
			registry: {
				keyType: 'CrmAdapterDomain',
				valueType: 'ICrmPort',
				entries: [{ key: 'sf', provider: 'SfAdapter' }],
			},
			coKeyedRegistries: [
				{
					keyType: 'CrmAdapterDomain',
					valueType: 'ICrmAuth',
					entries: [{ key: 'sf', provider: 'SfAuth' }],
				},
			],
		});
		expect(
			validateOrchestrationProject({
				orchestrationPatterns: [orch],
				domainPatternNames: [],
			}),
		).toEqual([]);
	});
});

describe('validateOrchestrationProject — name collision (Rule 1)', () => {
	test('orchestration name shared with a domain pattern → error', () => {
		const orch = defineOrchestrationPattern({
			name: 'Integrated', // collides with the library domain pattern
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				valueType: 'V',
				entries: [{ key: 'a', provider: 'AP' }],
			},
		});
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: ['Integrated', 'Activity'],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.severity).toBe('error');
		expect(issues[0]!.type).toBe('pattern_name_collision');
		expect(issues[0]!.message).toMatch(/'Integrated'/);
		expect(issues[0]!.message).toMatch(/domain pattern/);
	});
});

describe('validateOrchestrationProject — empty entries (Rule 2)', () => {
	test('co-keyed registry with empty entries → error', () => {
		// Loader rejects empty primary; co-keyed siblings can slip through
		// since they don't go via assertOrchestrationContribution.
		const orch: OrchestrationPatternDefinition = {
			name: 'EmptyCoKeyed',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				valueType: 'V',
				entries: [{ key: 'a', provider: 'AP' }],
			},
			coKeyedRegistries: [
				{ keyType: 'K', valueType: 'V2', entries: [] },
			],
		};
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_entries_empty');
	});
});

describe('validateOrchestrationProject — duplicate entry key (Rule 3b)', () => {
	test('two entries sharing a key → error', () => {
		const orch: OrchestrationPatternDefinition = {
			name: 'DupKey',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				valueType: 'V',
				entries: [
					{ key: 'sf', provider: 'A' },
					{ key: 'sf', provider: 'B' },
				],
			},
		};
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_entry_key_duplicate');
		expect(issues[0]!.message).toMatch(/'sf'/);
	});
});

describe('validateOrchestrationProject — malformed entry (Rule 3a)', () => {
	test('entry with empty provider → error', () => {
		const orch: OrchestrationPatternDefinition = {
			name: 'BadProvider',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				valueType: 'V',
				entries: [
					{ key: 'sf', provider: 'OK' },
					{ key: 'hub', provider: '' as unknown as string },
				],
			},
		};
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_entry_malformed');
		expect(issues[0]!.message).toMatch(/'hub'/);
	});

	test('entry with empty key → error', () => {
		const orch: OrchestrationPatternDefinition = {
			name: 'BadKey',
			kind: 'orchestration',
			registry: {
				keyType: 'K',
				valueType: 'V',
				entries: [{ key: '' as unknown as string, provider: 'OK' }],
			},
		};
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_entry_malformed');
	});
});

describe('validateOrchestrationProject — co-keyed keyType mismatch (Rule 4)', () => {
	test('co-keyed registry with divergent keyType → error', () => {
		const orch = defineOrchestrationPattern({
			name: 'Mismatch',
			kind: 'orchestration',
			registry: {
				keyType: 'CrmAdapterDomain',
				valueType: 'ICrmPort',
				entries: [{ key: 'sf', provider: 'SfAdapter' }],
			},
			coKeyedRegistries: [
				{
					keyType: 'AnotherKey',
					valueType: 'ICrmAuth',
					entries: [{ key: 'sf', provider: 'SfAuth' }],
				},
			],
		});
		const issues = validateOrchestrationProject({
			orchestrationPatterns: [orch],
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_cokeyed_keytype_mismatch');
		expect(issues[0]!.message).toMatch(/'AnotherKey'/);
		expect(issues[0]!.message).toMatch(/'CrmAdapterDomain'/);
	});
});

// ============================================================================
// Loader integration — fixture files exercise the import path
// ============================================================================

describe('loadAppPatterns — orchestration routing', () => {
	const fixturesDir = path.resolve(
		path.dirname(import.meta.url.replace('file://', '')),
		'fixtures/orchestration',
	);

	test('valid orchestration fixture lands in the orchestration map', async () => {
		_resetRegistryForTests();
		const result = await loadAppPatterns(
			['valid-crm-ports.pattern.ts'],
			fixturesDir,
		);
		expect(result.errors).toEqual([]);
		expect(result.loaded).toContain('CrmPorts');
		expect(getOrchestrationPattern('CrmPorts')?.name).toBe('CrmPorts');
		expect(getOrchestrationPatternNames()).toEqual(['CrmPorts']);
		// Domain accessor must NOT see it.
		const { getPattern } = await import('../../patterns/registry.ts');
		expect(getPattern('CrmPorts')).toBeUndefined();
	});

	test('co-keyed fixture loads cleanly and validator returns []', async () => {
		_resetRegistryForTests();
		const result = await loadAppPatterns(
			['valid-co-keyed-crm.pattern.ts'],
			fixturesDir,
		);
		expect(result.errors).toEqual([]);
		expect(result.loaded).toContain('CrmPortsCoKeyed');
		expect(
			validateOrchestrationProject({
				orchestrationPatterns: getAllOrchestrationPatterns(),
				domainPatternNames: [],
			}),
		).toEqual([]);
	});
});

describe('loadAppPatterns — duplicate-name detection', () => {
	let tmpdir: string;

	function writePatternFile(relPath: string, source: string): string {
		const abs = path.join(tmpdir, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, source, 'utf8');
		return abs;
	}

	afterAll(() => {
		try {
			for (const leftover of fs.readdirSync(os.tmpdir())) {
				if (leftover.startsWith('orch-loader-')) {
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

	test('two orchestration fixtures with the same name → loader error', async () => {
		tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-loader-'));
		fs.mkdirSync(path.join(tmpdir, 'src', 'patterns'), { recursive: true });
		_resetRegistryForTests();

		const defModule = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/pattern-definition.ts',
		);

		const fileBody = (exportName: string) => `
import { defineOrchestrationPattern } from '${defModule}';
export const ${exportName} = defineOrchestrationPattern({
	name: 'DupName',
	kind: 'orchestration',
	registry: {
		keyType: 'K',
		valueType: 'V',
		entries: [{ key: 'a', provider: 'AP' }],
	},
});
`;

		writePatternFile('src/patterns/a.pattern.ts', fileBody('FirstPattern'));
		writePatternFile('src/patterns/b.pattern.ts', fileBody('SecondPattern'));

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		// First load succeeds; second one is rejected with a duplicate-name error.
		expect(result.loaded).toEqual(['DupName']);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toMatch(/duplicates a previously loaded/);
	});

	test('two domain fixtures with the same name → loader error (symmetric protection)', async () => {
		tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-loader-'));
		fs.mkdirSync(path.join(tmpdir, 'src', 'patterns'), { recursive: true });
		_resetRegistryForTests();

		const defModule = path.resolve(
			path.dirname(import.meta.url.replace('file://', '')),
			'../../patterns/pattern-definition.ts',
		);

		const fileBody = (exportName: string) => `
import { definePattern } from '${defModule}';
export const ${exportName} = definePattern({
	name: 'DupDomain',
	repositoryClass: 'R',
});
`;

		writePatternFile('src/patterns/a.pattern.ts', fileBody('FirstPattern'));
		writePatternFile('src/patterns/b.pattern.ts', fileBody('SecondPattern'));

		const result = await loadAppPatterns(
			['src/patterns/*.pattern.ts'],
			tmpdir,
		);

		expect(result.loaded).toEqual(['DupDomain']);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toMatch(/duplicates a previously loaded app pattern/);
	});
});

describe('loadAppPatterns — orchestration assertion failures', () => {
	const fixturesDir = path.resolve(
		path.dirname(import.meta.url.replace('file://', '')),
		'fixtures/orchestration',
	);

	test('malformed-entries fixture loads (one bad provider, but entries non-empty); validator catches it', async () => {
		_resetRegistryForTests();
		const result = await loadAppPatterns(
			['malformed-entries.pattern.ts'],
			fixturesDir,
		);
		// Loader's assertOrchestrationContribution only checks shape +
		// non-empty entries — malformed individual entries pass loader but
		// surface in validator.
		expect(result.errors).toEqual([]);
		expect(result.loaded).toContain('MalformedEntries');

		const issues = validateOrchestrationProject({
			orchestrationPatterns: getAllOrchestrationPatterns(),
			domainPatternNames: [],
		});
		expect(issues.length).toBe(1);
		expect(issues[0]!.type).toBe('pattern_entry_malformed');
	});
});
