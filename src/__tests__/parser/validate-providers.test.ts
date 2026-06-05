/**
 * Tests for the provider cross-validator (RFC-0001 §1, D1).
 *
 * Covers the rules a single-file parse cannot express:
 *   - `slug` uniqueness across the providers dir,
 *   - `surfaces[]` ⊆ the union of entity `surface:` declarations,
 *   - pre-flight resolution of `auth.strategy` / `client.class` against real
 *     exports on disk (module-not-found and export-not-found cases),
 *   - the entity-surface union helper.
 *
 * Fixtures: a fake consumer source tree under fixtures/provider-src/ (the
 * strategy + client classes the refs point at), provider YAML under
 * fixtures/providers/, and entity YAML carrying `surface:` under
 * fixtures/entities/.
 */

import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import {
	validateProviders,
	collectEntitySurfaces,
	resolveImportRef,
	type LoadedProvider,
} from '../../parser/validate-providers';
import {
	loadProvidersFromYaml,
	loadProviderFromYaml,
} from '../../utils/yaml-loader';
import { loadEntityFromYaml } from '../../utils/yaml-loader';
import { findYamlFiles } from '../../utils/find-yaml-files';

const FIX = resolve(import.meta.dir, 'fixtures');
const PROVIDER_SRC = resolve(FIX, 'provider-src');
const ALIASES = { '@app': PROVIDER_SRC };

function loadEntitySurfaces(): Set<string> {
	const files = findYamlFiles(resolve(FIX, 'entities'));
	const defs = files.map((f) => {
		const r = loadEntityFromYaml(f);
		if (!r.success) throw new Error(`fixture entity failed to load: ${f}`);
		return r.definition;
	});
	return collectEntitySurfaces(defs);
}

function loadValidProviders(): LoadedProvider[] {
	const files = findYamlFiles(resolve(FIX, 'providers'));
	const { successes, failures } = loadProvidersFromYaml(files);
	if (failures.length) {
		throw new Error(
			`fixture providers failed to load: ${failures.map((f) => f.error).join('; ')}`,
		);
	}
	return successes.map((s) => ({ definition: s.definition, filePath: s.filePath }));
}

describe('collectEntitySurfaces', () => {
	it('builds the union of entity surface: declarations', () => {
		const surfaces = loadEntitySurfaces();
		expect([...surfaces].sort()).toEqual(['calendar', 'crm', 'mail', 'transcript']);
	});

	it('ignores entities without a surface', () => {
		const surfaces = collectEntitySurfaces([
			{ entity: { surface: 'crm' } },
			{ entity: {} },
			{ entity: { surface: undefined } },
		]);
		expect([...surfaces]).toEqual(['crm']);
	});
});

describe('resolveImportRef', () => {
	it('resolves an aliased ref to a real export', () => {
		const r = resolveImportRef(
			'@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy',
			{ sourceRoot: PROVIDER_SRC, aliases: ALIASES },
		);
		expect(r.status).toBe('ok');
	});

	it('reports module-not-found for a bad path', () => {
		const r = resolveImportRef(
			'@app/integrations/providers/google/does-not-exist#GoogleOAuthStrategy',
			{ sourceRoot: PROVIDER_SRC, aliases: ALIASES },
		);
		expect(r.status).toBe('module-not-found');
	});

	it('reports export-not-found for a missing named export', () => {
		const r = resolveImportRef(
			'@app/integrations/providers/google/google.client#NoSuchClient',
			{ sourceRoot: PROVIDER_SRC, aliases: ALIASES },
		);
		expect(r.status).toBe('export-not-found');
	});
});

describe('validateProviders — valid set', () => {
	it('produces no issues for google + hubspot against real exports', () => {
		const issues = validateProviders(loadValidProviders(), {
			entitySurfaces: loadEntitySurfaces(),
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		});
		expect(issues).toEqual([]);
	});
});

describe('validateProviders — unknown surface', () => {
	it('errors when a provider serves a surface no entity declares', () => {
		const google = loadProviderFromYaml(resolve(FIX, 'providers/google.yaml'));
		if (!google.success) throw new Error('fixture load failed');
		const issues = validateProviders(
			[{ definition: google.definition, filePath: google.filePath }],
			{
				// 'transcript' is absent from the known set
				entitySurfaces: new Set(['calendar', 'mail']),
				sourceRoot: PROVIDER_SRC,
				aliases: ALIASES,
			},
		);
		const unknown = issues.filter((i) => i.type === 'provider_unknown_surface');
		expect(unknown).toHaveLength(1);
		expect(unknown[0].message).toContain('transcript');
	});
});

describe('validateProviders — duplicate slug', () => {
	it('errors when the same slug appears in two files', () => {
		const google = loadProviderFromYaml(resolve(FIX, 'providers/google.yaml'));
		if (!google.success) throw new Error('fixture load failed');
		const dup: LoadedProvider[] = [
			{ definition: google.definition, filePath: '/a/google.yaml' },
			{ definition: google.definition, filePath: '/b/google.yaml' },
		];
		const issues = validateProviders(dup, {
			entitySurfaces: loadEntitySurfaces(),
			skipImportCheck: true,
		});
		const dupes = issues.filter((i) => i.type === 'provider_duplicate_slug');
		expect(dupes).toHaveLength(2);
		expect(dupes[0].message).toContain("slug 'google'");
	});
});

describe('validateProviders — pre-flight import check', () => {
	it('errors when auth.strategy module cannot be resolved', () => {
		const google = loadProviderFromYaml(resolve(FIX, 'providers/google.yaml'));
		if (!google.success) throw new Error('fixture load failed');
		const broken = {
			...google.definition,
			auth: {
				...google.definition.auth,
				strategy: '@app/integrations/providers/google/typo.strategy#GoogleOAuthStrategy',
			},
		};
		const issues = validateProviders(
			[{ definition: broken, filePath: google.filePath }],
			{
				entitySurfaces: loadEntitySurfaces(),
				sourceRoot: PROVIDER_SRC,
				aliases: ALIASES,
			},
		);
		const importErrs = issues.filter((i) => i.type === 'provider_import_unresolved');
		expect(importErrs).toHaveLength(1);
		expect(importErrs[0].message).toContain('auth.strategy');
	});

	it('errors when client.class export is missing', () => {
		const google = loadProviderFromYaml(resolve(FIX, 'providers/google.yaml'));
		if (!google.success) throw new Error('fixture load failed');
		const broken = {
			...google.definition,
			client: {
				...google.definition.client,
				class: '@app/integrations/providers/google/google.client#WrongName',
			},
		};
		const issues = validateProviders(
			[{ definition: broken, filePath: google.filePath }],
			{
				entitySurfaces: loadEntitySurfaces(),
				sourceRoot: PROVIDER_SRC,
				aliases: ALIASES,
			},
		);
		const importErrs = issues.filter((i) => i.type === 'provider_import_unresolved');
		expect(importErrs).toHaveLength(1);
		expect(importErrs[0].message).toContain('client.class');
		expect(importErrs[0].message).toContain('WrongName');
	});

	it('skipImportCheck bypasses the filesystem check but keeps slug/surface', () => {
		const google = loadProviderFromYaml(resolve(FIX, 'providers/google.yaml'));
		if (!google.success) throw new Error('fixture load failed');
		const broken = {
			...google.definition,
			auth: { ...google.definition.auth, strategy: '@app/totally/missing#Nope' },
		};
		const issues = validateProviders(
			[{ definition: broken, filePath: google.filePath }],
			{ entitySurfaces: loadEntitySurfaces(), skipImportCheck: true },
		);
		expect(issues).toEqual([]);
	});
});

describe('validateProviders — planned providers (roadmap stubs)', () => {
	it('skips the surface closed-set check and import pre-flight for planned providers', () => {
		const planned: LoadedProvider = {
			definition: {
				slug: 'github',
				display_name: 'GitHub',
				status: 'planned',
				// Neither surface exists in the fixture entity set, and there is no
				// auth/client to pre-flight — both checks must be skipped.
				surfaces: ['source_control'],
				display: { category: 'source-control' },
			},
			filePath: '/definitions/providers/github.yaml',
		};
		const issues = validateProviders([...loadValidProviders(), planned], {
			entitySurfaces: loadEntitySurfaces(),
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		});
		expect(issues).toEqual([]);
	});

	it('still enforces slug uniqueness against planned providers', () => {
		const valid = loadValidProviders();
		const dupe: LoadedProvider = {
			definition: {
				slug: valid[0].definition.slug,
				status: 'planned',
				surfaces: ['whatever'],
			},
			filePath: '/definitions/providers/dupe.yaml',
		};
		const issues = validateProviders([...valid, dupe], {
			entitySurfaces: loadEntitySurfaces(),
			skipImportCheck: true,
		});
		expect(issues.some((i) => i.type === 'provider_duplicate_slug')).toBe(true);
	});
});
