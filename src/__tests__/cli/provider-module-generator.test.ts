/**
 * Template-emission tests for provider module codegen (RFC-0001 §2, D2).
 *
 * Baseline covers clean-arch only, so these are explicit emission tests for the
 * new `<slug>.provider.module.ts` output: structure of the rendered module,
 * the @generated banner + idempotency contract, naming, the validation gate
 * (no emit on a bad import path / unknown surface / dup slug), and the
 * tsconfig path-alias resolver that feeds the pre-flight import check.
 *
 * Reuses the D1 fixture tree (provider YAML + a fake consumer source tree).
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
	generateProviderModule,
	generateProviderModules,
	providerPascalCase,
	providerConstantCase,
	resolveTsconfigAliases,
} from '../../cli/shared/provider-module-generator';
import { loadProviderFromYaml } from '../../utils/yaml-loader';
import { GENERATED_BANNER_MARKER } from '../../../templates/_shared/generated-banner.mjs';

const D1_FIX = resolve(import.meta.dir, '../parser/fixtures');
const PROVIDER_SRC = resolve(D1_FIX, 'provider-src');
const ALIASES = { '@app': PROVIDER_SRC };
const ENTITY_SURFACES = new Set(['calendar', 'mail', 'transcript', 'crm']);

function loadFixture(name: string) {
	const r = loadProviderFromYaml(resolve(D1_FIX, `providers/${name}`));
	if (!r.success) throw new Error(`fixture ${name} failed to load`);
	return r.definition;
}

describe('naming helpers', () => {
	it('pascal/constant case a multi-word slug', () => {
		expect(providerPascalCase('hubspot-crm')).toBe('HubspotCrm');
		expect(providerConstantCase('hubspot-crm')).toBe('HUBSPOT_CRM');
		expect(providerPascalCase('google')).toBe('Google');
		expect(providerConstantCase('google')).toBe('GOOGLE');
	});
});

describe('generateProviderModule — rendered shape', () => {
	const out = generateProviderModule(loadFixture('google.yaml'), 'definitions/providers/google.yaml');

	it('carries the @generated banner with the source path', () => {
		expect(out.startsWith('// ' + GENERATED_BANNER_MARKER)).toBe(true);
		expect(out).toContain('definitions/providers/google.yaml');
		expect(out).toContain('DO NOT EDIT');
	});

	it('is client-less + registry-backed for an all-read-primitive provider (RFC-0003 R5)', () => {
		// google serves only read-primitive surfaces (calendar/mail/transcript), so
		// it uses per-connection auth: no singleton strategy/client class is
		// instantiated — the strategy is resolved from STRATEGY_REGISTRY.
		expect(out).toContain(
			"import {\n  type ProviderStrategyRegistry,\n  STRATEGY_REGISTRY,\n} from '@pattern-stack/codegen/subsystems';",
		);
		// neither the strategy class nor the client class is imported/instantiated.
		expect(out).not.toContain('GoogleOAuthStrategy');
		expect(out).not.toContain('GoogleClient');
	});

	it('mints only the auth-strategy DI token + a named module class (no client token)', () => {
		expect(out).toContain("export const GOOGLE_AUTH_STRATEGY = Symbol('GOOGLE_AUTH_STRATEGY');");
		expect(out).toContain("const PROVIDER_SLUG = 'google';");
		expect(out).toContain('export class GoogleProviderModule {}');
		// the singleton client token is dropped entirely.
		expect(out).not.toContain('GOOGLE_CLIENT');
	});

	it('resolves the strategy from STRATEGY_REGISTRY via useFactory + exports only the token', () => {
		expect(out).toContain('provide: GOOGLE_AUTH_STRATEGY,');
		expect(out).toContain('useFactory: (registry: ProviderStrategyRegistry) =>');
		expect(out).toContain('registry.get(PROVIDER_SLUG)');
		expect(out).toContain('inject: [STRATEGY_REGISTRY],');
		expect(out).toContain('exports: [GOOGLE_AUTH_STRATEGY],');
	});

	it('documents the surfaces the provider serves', () => {
		expect(out).toContain('Surfaces: calendar, mail, transcript.');
	});

	it('is byte-identical on re-render (idempotency contract)', () => {
		const again = generateProviderModule(loadFixture('google.yaml'), 'definitions/providers/google.yaml');
		expect(again).toBe(out);
	});

	it('uses constant-case tokens for a multi-word slug', () => {
		const hub = loadFixture('hubspot.yaml');
		const rendered = generateProviderModule({ ...hub, slug: 'hubspot-crm' }, 'x.yaml');
		expect(rendered).toContain('HUBSPOT_CRM_AUTH_STRATEGY');
		expect(rendered).toContain('export class HubspotCrmProviderModule {}');
	});

	it('keeps the client-ful, bare-class shape for a crm (non-read-primitive) provider', () => {
		// hubspot serves `crm` (provider-level single-account auth) — it MUST retain
		// the singleton client token + the direct strategy/client class providers.
		const rendered = generateProviderModule(loadFixture('hubspot.yaml'), 'x.yaml');
		expect(rendered).toContain("export const HUBSPOT_CLIENT = Symbol('HUBSPOT_CLIENT');");
		expect(rendered).toContain('{ provide: HUBSPOT_AUTH_STRATEGY, useExisting:');
		expect(rendered).toContain('{ provide: HUBSPOT_CLIENT, useExisting:');
		// crm is NOT registry-backed.
		expect(rendered).not.toContain('STRATEGY_REGISTRY');
	});
});

describe('resolveTsconfigAliases', () => {
	it('maps compilerOptions.paths to absolute alias dirs', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cgp-tsconfig-'));
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					baseUrl: '.',
					paths: { '@app/*': ['./src/*'], '@shared/*': ['./src/shared/*'] },
				},
			}),
		);
		const res = resolveTsconfigAliases(dir);
		expect(res).not.toBeNull();
		expect(res!.aliases['@app']).toBe(resolve(dir, 'src'));
		expect(res!.aliases['@shared']).toBe(resolve(dir, 'src/shared'));
	});

	it('tolerates tsconfig with comments', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cgp-tsconfig-'));
		writeFileSync(
			join(dir, 'tsconfig.json'),
			'{\n  // editor comment\n  "compilerOptions": { "paths": { "@app/*": ["./src/*"] } }\n}',
		);
		const res = resolveTsconfigAliases(dir);
		expect(res!.aliases['@app']).toBe(resolve(dir, 'src'));
	});

	it('returns null when no tsconfig is present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cgp-tsconfig-'));
		expect(resolveTsconfigAliases(dir)).toBeNull();
	});
});

describe('generateProviderModules — orchestration', () => {
	it('skips cleanly when the providers dir is absent', () => {
		const res = generateProviderModules({
			providersDir: resolve(tmpdir(), 'cgp-does-not-exist-xyz'),
			outputRoot: resolve(tmpdir(), 'cgp-out-xyz'),
			entitySurfaces: ENTITY_SURFACES,
			skipImportCheck: true,
		});
		expect(res.skipped).toBe(true);
		expect(res.written).toEqual([]);
		expect(res.issues).toEqual([]);
	});

	it('emits one module per provider against the real fixture exports', () => {
		const outRoot = mkdtempSync(join(tmpdir(), 'cgp-emit-'));
		const res = generateProviderModules({
			providersDir: resolve(D1_FIX, 'providers'),
			outputRoot: outRoot,
			entitySurfaces: ENTITY_SURFACES,
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		});
		expect(res.skipped).toBe(false);
		expect(res.issues).toEqual([]);
		expect(res.written).toHaveLength(2);
		expect(existsSync(join(outRoot, 'google/google.provider.module.ts'))).toBe(true);
		expect(existsSync(join(outRoot, 'hubspot/hubspot.provider.module.ts'))).toBe(true);
		const google = readFileSync(join(outRoot, 'google/google.provider.module.ts'), 'utf-8');
		expect(google).toContain('export class GoogleProviderModule {}');
	});

	it('re-emit on unchanged input produces byte-identical files', () => {
		const outRoot = mkdtempSync(join(tmpdir(), 'cgp-idem-'));
		const opts = {
			providersDir: resolve(D1_FIX, 'providers'),
			outputRoot: outRoot,
			entitySurfaces: ENTITY_SURFACES,
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		};
		generateProviderModules(opts);
		const first = readFileSync(join(outRoot, 'google/google.provider.module.ts'), 'utf-8');
		generateProviderModules(opts);
		const second = readFileSync(join(outRoot, 'google/google.provider.module.ts'), 'utf-8');
		expect(second).toBe(first);
	});

	it('GATE: a bad import path blocks emission and reports the issue', () => {
		const outRoot = mkdtempSync(join(tmpdir(), 'cgp-gate-'));
		// Stage a providers dir with a broken strategy ref.
		const provDir = mkdtempSync(join(tmpdir(), 'cgp-prov-'));
		writeFileSync(
			join(provDir, 'broken.yaml'),
			[
				'slug: broken',
				'auth:',
				'  type: api-key',
				"  strategy: '@app/integrations/providers/google/missing.strategy#Nope'",
				'client:',
				"  class: '@app/integrations/providers/google/google.client#GoogleClient'",
				'  base_url: https://example.com',
				'surfaces: [crm]',
				'',
			].join('\n'),
		);
		const res = generateProviderModules({
			providersDir: provDir,
			outputRoot: outRoot,
			entitySurfaces: ENTITY_SURFACES,
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		});
		expect(res.written).toEqual([]);
		expect(res.issues.some((i) => i.type === 'provider_import_unresolved')).toBe(true);
		expect(existsSync(join(outRoot, 'broken'))).toBe(false);
	});

	it('GATE: an unknown surface blocks emission', () => {
		const outRoot = mkdtempSync(join(tmpdir(), 'cgp-gate2-'));
		const res = generateProviderModules({
			providersDir: resolve(D1_FIX, 'providers'),
			outputRoot: outRoot,
			entitySurfaces: new Set(['crm']), // google needs calendar/mail/transcript
			sourceRoot: PROVIDER_SRC,
			aliases: ALIASES,
		});
		expect(res.written).toEqual([]);
		expect(res.issues.some((i) => i.type === 'provider_unknown_surface')).toBe(true);
	});
});
